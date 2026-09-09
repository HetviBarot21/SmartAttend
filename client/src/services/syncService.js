/**
 * Outbound attendance sync - the drain half of the Tier 1 sync loop.
 *
 * Pipeline position:
 *
 *   AttendanceForm -> addAttendanceEvent() -> Dexie `attendanceEvents` + `syncQueue`
 *                                              |
 *                                       **drainSyncQueue()**  <- this module
 *                                              |
 *                                     POST /api/sync (Tier 2)  -> AWS
 *
 * `src/db/database.js` writes every record and a matching `syncQueue` row
 * (`status: 'pending'`) in one transaction. This module reads those pending
 * rows back, joins each to its attendance record, POSTs them in batches, and
 * moves each row to `synced` or `failed` based on the server's per-record
 * answer. Failed rows carry an exponential-backoff `nextAttemptAt` so a retry
 * storm cannot hammer a struggling server.
 *
 * Layering note: the service worker also keeps a Workbox Background Sync queue
 * (src/workers/syncQueue.js). That is a transport-level net for requests that
 * were already in flight when the network dropped. THIS queue - the Dexie one -
 * is the durable source of truth the teacher sees ("N records awaiting sync").
 * The service worker calls `drainSyncQueue()` from its `sync` handler so both
 * drain together when connectivity returns.
 */

import { db } from '../db/database';

/** Same-origin endpoint on the Tier 2 Express server. */
export const SYNC_ENDPOINT = '/api/sync';

/** Background Sync tag the page registers and the service worker listens for. */
export const DRAIN_SYNC_TAG = 'smartattend-drain-sync';

/** Records per POST. The server schema caps a batch at 500; stay well under. */
export const BATCH_SIZE = 100;

/** Backoff floor: a first failure waits this long before the next attempt. */
export const RETRY_BASE_MS = 60_000; // 1 minute

/** Backoff ceiling. Matches the Tier 2 syncWorker's `min(1_800_000, ...)`. */
export const RETRY_MAX_MS = 30 * 60_000; // 30 minutes

/**
 * Skip reasons the server may report that a retry could still clear. Every
 * other reason (`duplicate_event_id`, `duplicate_student_date`,
 * `unknown_student`, `duplicate_race`) is terminal - the record is either
 * already stored or will never be accepted as-is, so we stop resending it.
 */
const RETRYABLE_SKIP_REASONS = new Set(['insert_error']);

/**
 * Exponential backoff for a queue row that has failed `attemptCount` times
 * (1 = it has failed once). `base * 2^(attemptCount - 1)`, capped at `max`.
 *
 * @param {number} attemptCount  failures so far, 1-based
 * @returns {number} milliseconds to wait before the next attempt
 */
export function backoffMs(attemptCount, { base = RETRY_BASE_MS, max = RETRY_MAX_MS } = {}) {
  const n = Math.max(1, attemptCount);
  return Math.min(max, base * 2 ** (n - 1));
}

/** Project an attendance record onto exactly the fields attendanceSync.schema.js allows. */
function toSyncRecord(event) {
  return {
    eventId: event.eventId,
    studentId: event.studentId,
    date: event.date,
    status: event.status,
    captureMethod: event.captureMethod || 'manual',
    recordedBy: event.recordedBy ?? null,
    createdAt: event.createdAt,
  };
}

/**
 * Split a batch's queue rows into those the server has finished with and those
 * worth resending, using its `{ inserted: [eventId], skipped: [{eventId, reason}] }`
 * response. A row the server did not mention at all is resent, defensively.
 */
function classifyResponse(rows, result) {
  const inserted = new Set(result?.inserted ?? []);
  const skipReason = new Map((result?.skipped ?? []).map((s) => [s.eventId, s.reason]));

  const settled = [];
  const retry = [];
  for (const row of rows) {
    if (inserted.has(row.eventId)) {
      settled.push(row);
    } else if (skipReason.has(row.eventId)) {
      if (RETRYABLE_SKIP_REASONS.has(skipReason.get(row.eventId))) retry.push(row);
      else settled.push(row);
    } else {
      retry.push(row);
    }
  }
  return { settled, retry };
}

/** Move rows to `synced` and stamp the matching attendance records, atomically. */
async function markSettled(rows, atMs) {
  if (rows.length === 0) return;
  const iso = new Date(atMs).toISOString();
  await db.transaction('rw', db.syncQueue, db.attendanceEvents, async () => {
    for (const row of rows) {
      await db.syncQueue.update(row.id, { status: 'synced', syncedAt: iso, lastError: null });
      await db.attendanceEvents.where('eventId').equals(row.eventId).modify({ syncedAt: iso });
    }
  });
}

/** Move rows to `failed`, bump the attempt count, and schedule the backoff. */
async function markFailed(rows, message, atMs) {
  if (rows.length === 0) return;
  const lastError = message ? String(message).slice(0, 500) : null;
  await db.transaction('rw', db.syncQueue, async () => {
    for (const row of rows) {
      const attemptCount = (row.attemptCount ?? 0) + 1;
      await db.syncQueue.update(row.id, {
        status: 'failed',
        attemptCount,
        nextAttemptAt: atMs + backoffMs(attemptCount),
        lastError,
      });
    }
  });
}

// Collapses concurrent triggers (the page's `online` event and the service
// worker's `sync` event can fire within milliseconds of each other) onto a
// single pass. The server dedupes on eventId, so a double POST is only wasteful,
// not wrong - but one pass is cheaper.
let inFlight = null;

/**
 * Drain every eligible `syncQueue` row to the sync endpoint.
 *
 * Eligible = `pending`, or `failed` whose `nextAttemptAt` has passed. Rows are
 * sent oldest-first in batches of `batchSize`. A transport failure (offline)
 * backs the current batch off and stops; a per-record server verdict decides
 * each remaining row individually.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.endpoint=SYNC_ENDPOINT]
 * @param {string}   [opts.deviceId]   included in the payload for the audit trail
 * @param {typeof fetch} [opts.fetchImpl=globalThis.fetch]
 * @param {() => number} [opts.now=Date.now]  injectable clock, for tests
 * @param {number}   [opts.batchSize=BATCH_SIZE]
 * @returns {Promise<{eligible:number, synced:number, failed:number, deferred:number, batches:number}>}
 */
export function drainSyncQueue(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = runDrain(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function runDrain({
  endpoint = SYNC_ENDPOINT,
  deviceId,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  batchSize = BATCH_SIZE,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('drainSyncQueue: no fetch implementation available');
  }

  const startedAt = now();
  const queued = await db.syncQueue.where('status').anyOf('pending', 'failed').toArray();
  const eligible = queued
    .filter((row) => row.status === 'pending' || !row.nextAttemptAt || row.nextAttemptAt <= startedAt)
    .sort((a, b) => a.id - b.id);

  const summary = {
    eligible: eligible.length,
    synced: 0,
    failed: 0,
    deferred: queued.length - eligible.length,
    batches: 0,
  };
  if (eligible.length === 0) return summary;

  // Join each queue row to its attendance record (they share `eventId`).
  const events = await db.attendanceEvents
    .where('eventId')
    .anyOf(eligible.map((r) => r.eventId))
    .toArray();
  const eventByEventId = new Map(events.map((e) => [e.eventId, e]));

  for (let i = 0; i < eligible.length; i += batchSize) {
    const slice = eligible.slice(i, i + batchSize);

    // An orphan row (its attendance record was deleted) can never sync. Retire
    // it so it stops blocking the queue - the data it pointed at is already gone.
    const orphans = slice.filter((row) => !eventByEventId.has(row.eventId));
    if (orphans.length > 0) {
      await markSettled(orphans, startedAt);
      summary.synced += orphans.length;
    }

    const rows = slice.filter((row) => eventByEventId.has(row.eventId));
    if (rows.length === 0) continue;

    const body = {
      deviceId,
      sentAt: new Date(startedAt).toISOString(),
      records: rows.map((row) => toSyncRecord(eventByEventId.get(row.eventId))),
    };

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Almost certainly still offline. Back this batch off and stop; the
      // untouched later batches stay `pending` for the next reconnect.
      await markFailed(rows, err?.message ?? 'network error', startedAt);
      summary.failed += rows.length;
      summary.batches += 1;
      break;
    }

    if (!response.ok) {
      await markFailed(rows, `sync endpoint responded ${response.status}`, startedAt);
      summary.failed += rows.length;
      summary.batches += 1;
      // 5xx / 429: server is unwell, stop pushing. 4xx: a malformed record in
      // this batch - move on so it cannot wedge the rest of the queue.
      if (response.status >= 500 || response.status === 429) break;
      continue;
    }

    const result = await response.json().catch(() => ({}));
    const { settled, retry } = classifyResponse(rows, result);
    await markSettled(settled, startedAt);
    await markFailed(retry, 'server deferred record', startedAt);
    summary.synced += settled.length;
    summary.failed += retry.length;
    summary.batches += 1;
  }

  return summary;
}

/**
 * Ask the browser to drain the queue when it next has connectivity.
 *
 * Prefers the Background Sync API (fires even if the tab is closed); falls back
 * to nudging the active service worker, then to a direct in-page drain when
 * there is no service worker at all (e.g. `vite dev` without the PWA plugin).
 *
 * @returns {Promise<'background-sync'|'message'|'direct'|'unavailable'>}
 */
export async function requestBackgroundSync() {
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('sw not ready')), 3000)),
      ]);
      if ('sync' in reg) {
        await reg.sync.register(DRAIN_SYNC_TAG);
        return 'background-sync';
      }
      // Firefox / Safari: no Background Sync - drain now via the active worker.
      reg.active?.postMessage({ type: 'REPLAY_SYNC' });
      return 'message';
    } catch {
      /* fall through to a direct drain */
    }
  }

  if (typeof globalThis.fetch === 'function') {
    await drainSyncQueue().catch(() => {});
    return 'direct';
  }
  return 'unavailable';
}

/**
 * Wire the page to trigger a sync whenever connectivity is restored, and once
 * now in case the app launched online with a backlog. Call from main.jsx.
 *
 * @returns {() => void} an unsubscribe function
 */
export function startSyncOnReconnect() {
  if (typeof window === 'undefined') return () => {};

  const trigger = () => { requestBackgroundSync().catch(() => {}); };
  window.addEventListener('online', trigger);
  if (navigator.onLine) trigger();

  return () => window.removeEventListener('online', trigger);
}
