'use strict';

/**
 * Outbound sync worker (runs as a worker_threads Worker, spawned by index.js).
 *
 * Every SYNC_POLL_INTERVAL_MS it:
 *   1. reads sync_queue rows with status='pending' that are due
 *      (next_attempt_at IS NULL OR <= now),
 *   2. splits them into batches of SYNC_BATCH_SIZE (50),
 *   3. POSTs each batch to the AWS API Gateway endpoint (SYNC_API_GATEWAY_URL),
 *   4. marks the rows the cloud accepted (inserted or already-present) as
 *      'synced' and stamps attendance_events.synced_at,
 *   5. on a retryable failure, schedules the row again with exponential backoff
 *      starting at SYNC_BACKOFF_MIN_MS (60s), doubling, capped at
 *      SYNC_BACKOFF_MAX_MS (30 min). After SYNC_MAX_ATTEMPTS it is parked as
 *      'dead'. A 4xx (bad payload) is parked as 'failed' immediately.
 *
 * ---------------------------------------------------------------------------
 * DynamoDB Local / no real AWS yet: point SYNC_API_GATEWAY_URL at a local shim
 * that invokes aws/lambda/syncHandler.js (e.g. `sam local start-api` or a tiny
 * Express wrapper). When real credentials arrive, set SYNC_API_GATEWAY_URL to
 * the deployed API Gateway invoke URL and SYNC_API_GATEWAY_KEY to its API key -
 * nothing else in this file changes.
 * ---------------------------------------------------------------------------
 */

const { parentPort, workerData, isMainThread } = require('worker_threads');

// A Worker inherits process.env, but index.js also forwards it explicitly.
if (workerData && workerData.env) {
  Object.assign(process.env, workerData.env);
}

const { db } = require('../db');

const POLL_INTERVAL_MS = Number(process.env.SYNC_POLL_INTERVAL_MS) || 30_000;
const BATCH_SIZE = Number(process.env.SYNC_BATCH_SIZE) || 50;
const BACKOFF_MIN_MS = Number(process.env.SYNC_BACKOFF_MIN_MS) || 60_000;
const BACKOFF_MAX_MS = Number(process.env.SYNC_BACKOFF_MAX_MS) || 30 * 60_000;
const MAX_ATTEMPTS = Number(process.env.SYNC_MAX_ATTEMPTS) || 12;
const REQUEST_TIMEOUT_MS = Number(process.env.SYNC_REQUEST_TIMEOUT_MS) || 15_000;
const API_URL = process.env.SYNC_API_GATEWAY_URL;
const API_KEY = process.env.SYNC_API_GATEWAY_KEY;
const DEVICE_ID = process.env.SYNC_DEVICE_ID || 'tier2-server';

function log(level, message, extra) {
  const line = { level, message, ...extra };
  if (parentPort) parentPort.postMessage(line);
  else console[level === 'error' ? 'error' : 'log']('[syncWorker]', line);
}

// --- prepared statements ----------------------------------------------------

const selectDue = db.prepare(`
  SELECT id, event_id, payload, attempt_count
  FROM sync_queue
  WHERE status = 'pending'
    AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
  ORDER BY created_at
  LIMIT @limit
`);

const markSynced = db.prepare(`
  UPDATE sync_queue
  SET status = 'synced', synced_at = @now, last_error = NULL, next_attempt_at = NULL
  WHERE event_id = @eventId
`);
const stampEventSynced = db.prepare(
  `UPDATE attendance_events SET synced_at = @now WHERE event_id = @eventId AND synced_at IS NULL`
);
const scheduleRetry = db.prepare(`
  UPDATE sync_queue
  SET attempt_count = attempt_count + 1,
      next_attempt_at = @nextAttemptAt,
      last_error = @error
  WHERE id = @id
`);
const park = db.prepare(`
  UPDATE sync_queue
  SET status = @status, attempt_count = attempt_count + 1, last_error = @error
  WHERE id = @id
`);
const audit = db.prepare(
  `INSERT INTO audit_log (action, actor_id, record_id, detail) VALUES (?, ?, ?, ?)`
);

// --- helpers --------------------------------------------------------------

function backoffMs(attemptCount) {
  // attemptCount is the number of attempts already made before this failure.
  const exp = BACKOFF_MIN_MS * 2 ** attemptCount;
  return Math.min(BACKOFF_MAX_MS, exp);
}

function chunk(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function postBatch(records) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(API_KEY ? { 'x-api-key': API_KEY } : {})
      },
      body: JSON.stringify({ deviceId: DEVICE_ID, sentAt: new Date().toISOString(), records }),
      signal: controller.signal
    });

    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

/** event_ids the cloud has confirmed are stored (freshly inserted or already there). */
function acceptedEventIds(batchRecords, body) {
  const ids = new Set();
  for (const key of ['inserted', 'skipped']) {
    for (const entry of body?.[key] ?? []) {
      ids.add(typeof entry === 'string' ? entry : entry.eventId);
    }
  }
  // A bare 2xx with no per-record detail means "the whole batch landed".
  if (ids.size === 0) for (const r of batchRecords) ids.add(r.eventId);
  return ids;
}

const settleBatch = db.transaction((rows, records, body) => {
  const now = new Date().toISOString();
  const accepted = acceptedEventIds(records, body);
  let synced = 0;
  const stillPending = [];

  for (const row of rows) {
    if (accepted.has(row.event_id)) {
      markSynced.run({ eventId: row.event_id, now });
      stampEventSynced.run({ eventId: row.event_id, now });
      synced += 1;
    } else {
      stillPending.push(row);
    }
  }
  return { synced, stillPending };
});

const failBatch = db.transaction((rows, { retryable, error }) => {
  const now = Date.now();
  let retried = 0;
  let parked = 0;
  for (const row of rows) {
    const attempts = row.attempt_count;
    if (retryable && attempts + 1 < MAX_ATTEMPTS) {
      const nextAttemptAt = new Date(now + backoffMs(attempts)).toISOString();
      scheduleRetry.run({ id: row.id, nextAttemptAt, error });
      retried += 1;
    } else {
      const status = retryable ? 'dead' : 'failed';
      park.run({ id: row.id, status, error });
      audit.run('sync.parked', 'tier2-server', row.event_id,
        JSON.stringify({ status, attempts: attempts + 1, error }));
      parked += 1;
    }
  }
  return { retried, parked };
});

// --- main loop -----------------------------------------------------------

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (!API_URL) {
      log('warn', 'SYNC_API_GATEWAY_URL is not set - skipping tick');
      return;
    }

    const due = selectDue.all({ now: new Date().toISOString(), limit: 5_000 });
    if (due.length === 0) return;

    log('info', `processing ${due.length} pending record(s)`);

    for (const batchRows of chunk(due, BATCH_SIZE)) {
      const records = batchRows.map((r) => JSON.parse(r.payload));
      let response;
      try {
        response = await postBatch(records);
      } catch (err) {
        // network error / timeout / DNS - always retryable
        const { retried, parked } = failBatch(batchRows, {
          retryable: true,
          error: `network: ${err.name || 'Error'}: ${err.message}`
        });
        log('warn', `batch network failure`, { retried, parked, error: err.message });
        continue;
      }

      if (response.ok) {
        const { synced, stillPending } = settleBatch(batchRows, records, response.body);
        log('info', `batch synced`, { synced, unconfirmed: stillPending.length });
        if (stillPending.length) {
          failBatch(stillPending, { retryable: true, error: 'not confirmed by cloud' });
        }
      } else if (response.status === 429 || response.status >= 500) {
        const { retried, parked } = failBatch(batchRows, {
          retryable: true,
          error: `http ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`
        });
        log('warn', `batch server error ${response.status}`, { retried, parked });
      } else {
        // 4xx other than 429: the payload will not become valid on retry.
        const { parked } = failBatch(batchRows, {
          retryable: false,
          error: `http ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`
        });
        log('error', `batch rejected ${response.status} - parked as failed`, { parked });
      }
    }
  } catch (err) {
    log('error', 'tick crashed', { error: err.message, stack: err.stack });
  } finally {
    ticking = false;
  }
}

function start() {
  log('info', `sync worker up: every ${POLL_INTERVAL_MS}ms, batches of ${BATCH_SIZE}`, {
    apiUrl: API_URL || '(unset)'
  });
  tick();
  const handle = setInterval(tick, POLL_INTERVAL_MS);
  handle.unref?.();
}

// Start when running as the spawned Worker, or when invoked directly for a
// one-off manual run. Stay quiet when required as a module (e.g. from tests).
if (!isMainThread || require.main === module) {
  start();
}

module.exports = { tick, backoffMs, chunk, acceptedEventIds };
