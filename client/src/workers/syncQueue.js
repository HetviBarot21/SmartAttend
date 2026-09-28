/* eslint-env serviceworker */
/**
 * Workbox Background Sync queue, run inside the service worker. It replays sync
 * POSTs that failed mid-flight. The Dexie `syncQueue` remains the source of truth.
 */

import { BackgroundSyncPlugin } from 'workbox-background-sync';
import { registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';

import { drainSyncQueue, DRAIN_SYNC_TAG } from '../services/syncService';

export const SYNC_QUEUE_NAME = 'smartattend-sync-queue';

export const SYNC_ENDPOINT_PATH = '/api/sync';

/** Matches Chrome's own 7-day Background Sync limit. */
export const MAX_RETENTION_MINUTES = 60 * 24 * 7;

async function broadcast(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

/** Drain the Dexie queue and tell open tabs so the pending badge refreshes. */
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

/** Replay oldest-first, stopping at the first failure to keep order. */
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
      throw err;
    }
  }
  if (replayed > 0) await broadcast({ type: 'SYNC_REPLAYED', count: replayed });

  await drainDurableQueue();
}

/**
 * Workbox only fires `sync` after a request fails into its queue, so records
 * saved while fully offline need their own tag to trigger a drain.
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

/** For a generateSW setup: add to `workbox.runtimeCaching`. */
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
