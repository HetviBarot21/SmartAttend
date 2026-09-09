/* eslint-env serviceworker */
/**
 * Workbox Background Sync queue for outbound attendance sync.
 *
 * This module runs **inside the service worker** (see src/sw/sw.js). It captures
 * POST requests to the sync endpoint that fail because the device is offline (or
 * the server is unreachable), stores them in IndexedDB, and lets the browser
 * replay them automatically when connectivity returns - including after the tab
 * has been closed, via the Background Sync API where supported, and on the next
 * SW startup where it is not.
 *
 * Layering note: the app also keeps its own durable queue in Dexie
 * (src/db/database.js `syncQueue` table). That is the source of truth the
 * teacher sees ("N records pending"). This Workbox queue is a second, transport
 * -level safety net for requests already in flight when the network drops.
 */

import { BackgroundSyncPlugin } from 'workbox-background-sync';
import { registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';

import { drainSyncQueue, DRAIN_SYNC_TAG } from '../services/syncService';

/** IndexedDB store name for the queued requests (visible in DevTools > Application). */
export const SYNC_QUEUE_NAME = 'smartattend-sync-queue';

/** Path (suffix) of the endpoint whose failed POSTs get queued. */
export const SYNC_ENDPOINT_PATH = '/api/sync';

/**
 * How long a queued request stays replayable. Chrome purges Background Sync
 * entries after ~7 days regardless; we match that so stale attendance is not
 * silently posted weeks later.
 */
export const MAX_RETENTION_MINUTES = 60 * 24 * 7;

async function broadcast(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

/**
 * Drain the durable Dexie `syncQueue` table (via src/services/syncService.js)
 * and tell open tabs how many records settled so the "pending" badge refreshes.
 * Best-effort: failed rows carry their own backoff `nextAttemptAt`, and the
 * page's `online` listener plus the dedicated `sync` tag reschedule the retry -
 * so a partial drain here does not need to throw.
 */
async function drainDurableQueue() {
  try {
    const summary = await drainSyncQueue();
    if (summary.synced > 0) await broadcast({ type: 'SYNC_REPLAYED', count: summary.synced });
    return summary;
  } catch (err) {
    console.warn('[sync] durable queue drain failed', err);
    return null;
  }
}

/**
 * Custom replay loop: drain the queue oldest-first, stop and re-queue on the
 * first failure so ordering is preserved and the browser reschedules with its
 * own backoff. Notifies open tabs when anything was flushed so the UI can
 * refresh the "pending" badge.
 *
 * The transport queue only ever holds requests that were mid-flight when the
 * network dropped; once it is clear we also drain the durable Dexie backlog,
 * since reaching this point means connectivity is back.
 */
async function replayQueue({ queue }) {
  let entry;
  let replayed = 0;
  while ((entry = await queue.shiftRequest())) {
    try {
      const response = await fetch(entry.request.clone());
      if (!response.ok) {
        throw new Error(`sync endpoint responded ${response.status}`);
      }
      replayed += 1;
    } catch (err) {
      await queue.unshiftRequest(entry);
      if (replayed > 0) await broadcast({ type: 'SYNC_REPLAYED', count: replayed });
      throw err; // signal Background Sync to retry later
    }
  }
  if (replayed > 0) await broadcast({ type: 'SYNC_REPLAYED', count: replayed });

  await drainDurableQueue();
}

/**
 * Register a dedicated `sync` listener for the durable-queue drain. Workbox's
 * BackgroundSyncPlugin only registers a sync event when a request has actually
 * failed into its queue, so a device that recorded attendance while offline but
 * never had a request fail mid-flight would otherwise never replay. The page
 * registers `DRAIN_SYNC_TAG` (see requestBackgroundSync) to cover that case.
 *
 * Call once from sw.js.
 */
export function registerDurableQueueSync() {
  self.addEventListener('sync', (event) => {
    if (event.tag === DRAIN_SYNC_TAG) {
      event.waitUntil(drainDurableQueue());
    }
  });
}

export const backgroundSyncPlugin = new BackgroundSyncPlugin(SYNC_QUEUE_NAME, {
  maxRetentionTime: MAX_RETENTION_MINUTES,
  onSync: replayQueue,
});

/**
 * Register the sync route on the service worker's router. Call once from sw.js.
 *
 * Matches only same-origin (or configured) POSTs to the sync endpoint; a
 * NetworkOnly strategy means a successful request passes straight through and
 * only failures fall into the queue.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.endpointPath=SYNC_ENDPOINT_PATH]
 * @param {(url: URL) => boolean} [opts.matchOrigin] extra origin guard
 */
export function registerSyncQueue({ endpointPath = SYNC_ENDPOINT_PATH, matchOrigin } = {}) {
  const matcher = ({ url, request }) => {
    if (request.method !== 'POST') return false;
    if (matchOrigin && !matchOrigin(url)) return false;
    return url.pathname.endsWith(endpointPath);
  };

  registerRoute(matcher, new NetworkOnly({ plugins: [backgroundSyncPlugin] }), 'POST');
  return backgroundSyncPlugin;
}

/**
 * For a generateSW (workbox-build) setup instead of a custom SW: spread this
 * into `workbox.runtimeCaching` in vite.config.js.
 *
 *   runtimeCaching: [syncRuntimeCachingEntry(), ...]
 */
export function syncRuntimeCachingEntry({ endpointPath = SYNC_ENDPOINT_PATH } = {}) {
  return {
    urlPattern: ({ url, request }) =>
      request.method === 'POST' && url.pathname.endsWith(endpointPath),
    handler: 'NetworkOnly',
    method: 'POST',
    options: {
      backgroundSync: {
        name: SYNC_QUEUE_NAME,
        options: { maxRetentionTime: MAX_RETENTION_MINUTES },
      },
    },
  };
}
