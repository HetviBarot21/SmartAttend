/**
 * Outbound sync worker (runs as a worker_threads Worker, spawned by server.js).
 *
 * Every config.sync.pollIntervalMs it:
 *   1. reads sync_queue rows with status='pending' that are due
 *      (next_attempt_at IS NULL OR <= now),
 *   2. splits them into batches of config.sync.batchSize (50),
 *   3. POSTs each batch to the AWS API Gateway endpoint (config.sync.apiUrl),
 *   4. marks the rows the cloud accepted (inserted or already-present) as
 *      'synced' and stamps attendance_events.synced_at,
 *   5. on a retryable failure, schedules the row again with exponential backoff
 *      starting at backoffMinMs (60s), doubling, capped at backoffMaxMs (30 min).
 *      After maxAttempts it is parked as 'dead'. A 4xx (bad payload) is parked
 *      as 'failed' immediately.
 *
 * ---------------------------------------------------------------------------
 * No real AWS yet: point SYNC_API_GATEWAY_URL at a local shim that invokes
 * aws/lambda/syncHandler.js (e.g. `sam local start-api` or a tiny Express
 * wrapper). When real credentials arrive, set SYNC_API_GATEWAY_URL to the
 * deployed API Gateway invoke URL and SYNC_API_GATEWAY_KEY to its API key -
 * nothing else in this file changes.
 * ---------------------------------------------------------------------------
 */

import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

// A Worker inherits process.env, but server.js also forwards it explicitly.
if (workerData && workerData.env) {
  Object.assign(process.env, workerData.env);
}

const { config } = await import('../config.js');
const { openDatabase } = await import('../db/index.js');

const {
  apiUrl: API_URL,
  apiKey: API_KEY,
  pollIntervalMs: POLL_INTERVAL_MS,
  batchSize: BATCH_SIZE,
  backoffMinMs: BACKOFF_MIN_MS,
  backoffMaxMs: BACKOFF_MAX_MS,
  maxAttempts: MAX_ATTEMPTS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  deviceId: DEVICE_ID,
} = config.sync;

// The worker thread opens its own connection to the same file; WAL mode lets it
// read/write alongside the HTTP server's connection.
const db = openDatabase();

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

const rebuildPayload = db.prepare(`
  SELECT event_id AS eventId, student_id AS studentId, date, status,
         capture_method AS captureMethod, recorded_by AS recordedBy, created_at
  FROM attendance_events WHERE event_id = ?
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
      last_attempt_at = @now,
      last_error = @error
  WHERE id = @id
`);
const park = db.prepare(`
  UPDATE sync_queue
  SET status = @status, attempt_count = attempt_count + 1,
      last_attempt_at = @now, last_error = @error
  WHERE id = @id
`);
const audit = db.prepare(
  `INSERT INTO audit_log (action, actor_id, record_id, detail) VALUES (?, ?, ?, ?)`
);

// --- helpers --------------------------------------------------------------

export function backoffMs(attemptCount) {
  // attemptCount is the number of attempts already made before this failure.
  const exp = BACKOFF_MIN_MS * 2 ** attemptCount;
  return Math.min(BACKOFF_MAX_MS, exp);
}

export function chunk(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** SQLite datetime('now') -> RFC3339, so a rebuilt payload passes the schema. */
function toIso(sqliteTs) {
  if (!sqliteTs) return new Date().toISOString();
  if (sqliteTs.includes('T')) return sqliteTs;
  return sqliteTs.replace(' ', 'T') + 'Z';
}

/** The record to POST for one queue row: the stored snapshot, or a rebuild. */
function payloadFor(row) {
  if (row.payload) return JSON.parse(row.payload);
  const r = rebuildPayload.get(row.event_id);
  if (!r) throw new Error(`no attendance_events row for ${row.event_id}`);
  return { ...r, createdAt: toIso(r.created_at), created_at: undefined };
}

async function postBatch(records) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
      },
      body: JSON.stringify({ deviceId: DEVICE_ID, sentAt: new Date().toISOString(), records }),
      signal: controller.signal,
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
export function acceptedEventIds(batchRecords, body) {
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
  const now = new Date().toISOString();
  const ms = Date.now();
  let retried = 0;
  let parked = 0;
  for (const row of rows) {
    const attempts = row.attempt_count;
    if (retryable && attempts + 1 < MAX_ATTEMPTS) {
      const nextAttemptAt = new Date(ms + backoffMs(attempts)).toISOString();
      scheduleRetry.run({ id: row.id, nextAttemptAt, now, error });
      retried += 1;
    } else {
      const status = retryable ? 'dead' : 'failed';
      park.run({ id: row.id, status, now, error });
      audit.run(
        'sync.parked',
        DEVICE_ID,
        row.event_id,
        JSON.stringify({ status, attempts: attempts + 1, error })
      );
      parked += 1;
    }
  }
  return { retried, parked };
});

// --- main loop -----------------------------------------------------------

let ticking = false;

export async function tick() {
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
      let records;
      try {
        records = batchRows.map(payloadFor);
      } catch (err) {
        failBatch(batchRows, { retryable: false, error: `payload: ${err.message}` });
        log('error', 'batch payload build failed - parked as failed', { error: err.message });
        continue;
      }

      let response;
      try {
        response = await postBatch(records);
      } catch (err) {
        // network error / timeout / DNS - always retryable
        const { retried, parked } = failBatch(batchRows, {
          retryable: true,
          error: `network: ${err.name || 'Error'}: ${err.message}`,
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
          error: `http ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`,
        });
        log('warn', `batch server error ${response.status}`, { retried, parked });
      } else {
        // 4xx other than 429: the payload will not become valid on retry.
        const { parked } = failBatch(batchRows, {
          retryable: false,
          error: `http ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`,
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

export function start() {
  log('info', `sync worker up: every ${POLL_INTERVAL_MS}ms, batches of ${BATCH_SIZE}`, {
    apiUrl: API_URL || '(unset)',
  });
  tick();
  const handle = setInterval(tick, POLL_INTERVAL_MS);
  handle.unref?.();
}

// Start when running as the spawned Worker, or when invoked directly for a
// one-off manual run. Stay quiet when imported as a module (e.g. from tests).
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (!isMainThread || invokedDirectly) {
  start();
}
