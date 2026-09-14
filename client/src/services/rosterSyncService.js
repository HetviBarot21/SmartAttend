/**
 * Outbound roster sync - pushes schools/classes/students/cards created or
 * edited on this device to the server's shared roster tables
 * (server/src/routes/roster.js), so a central admin's cross-class reports
 * (server/src/routes/admin.js) see them too.
 *
 * Mirrors services/syncService.js's role for attendance, but deliberately
 * simpler: roster writes are low-volume (a teacher adds a handful of students
 * a week, not hundreds of scans a day), so there is no batching or exponential
 * backoff here - just "try the queue in order on reconnect, stop at the first
 * failure." Stopping (rather than skipping past a failed row) matters because
 * later rows can depend on an earlier one landing first - a class push needs
 * its school row to exist, a student push needs its class - and
 * `db/database.js` enqueues them in that dependency order already.
 */

import { db } from '../db/database';

let inFlight = null;

/**
 * Drain every `pending`/`failed` rosterSyncQueue row, oldest first.
 * @returns {Promise<{attempted:number, synced:number, failed:number}>}
 */
export function drainRosterQueue(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = runDrain(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function runDrain({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('drainRosterQueue: no fetch implementation available');
  }

  const queued = await db.rosterSyncQueue.where('status').anyOf('pending', 'failed').toArray();
  const eligible = queued.sort((a, b) => a.id - b.id);

  const summary = { attempted: 0, synced: 0, failed: 0 };

  for (const row of eligible) {
    summary.attempted += 1;
    let response;
    try {
      response = await fetchImpl(row.path, {
        method: row.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row.body),
      });
    } catch (err) {
      await db.rosterSyncQueue.update(row.id, {
        status: 'failed', attemptCount: (row.attemptCount ?? 0) + 1, lastError: err?.message ?? 'network error',
      });
      summary.failed += 1;
      break; // almost certainly offline - the rest stay pending for the next reconnect
    }

    if (!response.ok) {
      await db.rosterSyncQueue.update(row.id, {
        status: 'failed', attemptCount: (row.attemptCount ?? 0) + 1, lastError: `roster endpoint responded ${response.status}`,
      });
      summary.failed += 1;
      break; // a later row may depend on this one - don't skip ahead
    }

    await db.rosterSyncQueue.update(row.id, { status: 'synced', syncedAt: new Date().toISOString(), lastError: null });
    summary.synced += 1;
  }

  return summary;
}

/** Drain now if there's a fetch available (i.e. running in a browser-like environment). */
export async function requestRosterSync() {
  if (typeof globalThis.fetch !== 'function') return;
  await drainRosterQueue().catch(() => {});
}

/**
 * Wire the page to push queued roster changes whenever connectivity is
 * restored, and once now in case the app launched online with a backlog.
 * Call from main.jsx, alongside startSyncOnReconnect().
 * @returns {() => void} an unsubscribe function
 */
export function startRosterSyncOnReconnect() {
  if (typeof window === 'undefined') return () => {};

  const trigger = () => { requestRosterSync().catch(() => {}); };
  window.addEventListener('online', trigger);
  if (navigator.onLine) trigger();

  return () => window.removeEventListener('online', trigger);
}
