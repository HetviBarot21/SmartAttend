/**
 * Pushes roster changes made on this device to the server. Rows are sent in
 * order and the drain stops at the first failure, because later rows can
 * depend on earlier ones (a student needs its class).
 */

import { db } from '../db/database';

let inFlight = null;

/**
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
      break; // probably offline
    }

    if (!response.ok) {
      await db.rosterSyncQueue.update(row.id, {
        status: 'failed', attemptCount: (row.attemptCount ?? 0) + 1, lastError: `roster endpoint responded ${response.status}`,
      });
      summary.failed += 1;
      break; // later rows may depend on this one
    }

    await db.rosterSyncQueue.update(row.id, { status: 'synced', syncedAt: new Date().toISOString(), lastError: null });
    summary.synced += 1;
  }

  return summary;
}

export async function requestRosterSync() {
  if (typeof globalThis.fetch !== 'function') return;
  await drainRosterQueue().catch(() => {});
}

/**
 * Push roster changes on every reconnect, and once now if online.
 * @returns {() => void} an unsubscribe function
 */
export function startRosterSyncOnReconnect() {
  if (typeof window === 'undefined') return () => {};

  const trigger = () => { requestRosterSync().catch(() => {}); };
  window.addEventListener('online', trigger);
  if (navigator.onLine) trigger();

  return () => window.removeEventListener('online', trigger);
}
