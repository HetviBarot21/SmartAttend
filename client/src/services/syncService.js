/**
 * Sends pending attendance records from the Dexie `syncQueue` to POST /api/sync
 * in batches, marking each row synced or failed (with exponential backoff).
 */

import { db } from '../db/database';

export const SYNC_ENDPOINT = '/api/sync';

export const DRAIN_SYNC_TAG = 'smartattend-drain-sync';

/** The server caps a batch at 500. */
export const BATCH_SIZE = 100;

export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 30 * 60_000;

/** Server skip reasons worth retrying. Every other reason is final. */
const RETRYABLE_SKIP_REASONS = new Set(['insert_error']);

/**
 * @param {number} attemptCount  failures so far, 1-based
 * @returns {number} milliseconds to wait before the next attempt
 */
export function backoffMs(attemptCount, { base = RETRY_BASE_MS, max = RETRY_MAX_MS } = {}) {
  const n = Math.max(1, attemptCount);
  return Math.min(max, base * 2 ** (n - 1));
}

/** Only the fields attendanceSync.schema.js allows. */
function toSyncRecord(event) {
  const record = {
    eventId: event.eventId,
    studentId: event.studentId,
    date: event.date,
    status: event.status,
    captureMethod: event.captureMethod || 'manual',
    recordedBy: event.recordedBy ?? null,
    createdAt: event.createdAt,
  };
  // Only sent when set: the server treats a missing reason as "none", so
  // clearing one (absent -> present) still reaches it via the status change.
  if (event.reason) record.reason = event.reason;
  return record;
}

/** Split rows into settled and retry. Rows the server did not mention are retried. */
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

// Concurrent triggers share one drain.
let inFlight = null;

/**
 * Send every pending row, and every failed row whose backoff has passed.
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

  const events = await db.attendanceEvents
    .where('eventId')
    .anyOf(eligible.map((r) => r.eventId))
    .toArray();
  const eventByEventId = new Map(events.map((e) => [e.eventId, e]));

  for (let i = 0; i < eligible.length; i += batchSize) {
    const slice = eligible.slice(i, i + batchSize);

    // Retire rows whose attendance record no longer exists.
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
      // Probably offline: stop and leave later batches pending.
      await markFailed(rows, err?.message ?? 'network error', startedAt);
      summary.failed += rows.length;
      summary.batches += 1;
      break;
    }

    if (!response.ok) {
      await markFailed(rows, `sync endpoint responded ${response.status}`, startedAt);
      summary.failed += rows.length;
      summary.batches += 1;
      // Stop on 5xx/429. On other 4xx, skip this batch so it cannot block the rest.
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
 * Uses Background Sync when available, else messages the service worker, else
 * drains directly in the page.
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
 * Sync on every reconnect, and once now if online.
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
