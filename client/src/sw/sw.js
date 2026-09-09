/* eslint-env serviceworker */
/**
 * Custom service worker (vite-plugin-pwa `injectManifest` strategy).
 *
 * Replaces the previous auto-generated SW so we can host the outbound sync
 * queue (src/workers/syncQueue.js) in the worker. Everything the old
 * generateSW config did - precache the app shell, NetworkFirst for API GETs -
 * is reproduced here.
 */

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

import { registerSyncQueue, registerDurableQueueSync } from '../workers/syncQueue';
import { drainSyncQueue } from '../services/syncService';

// `registerType: 'autoUpdate'` expects the new SW to take over immediately.
self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

// Injected at build time by vite-plugin-pwa.
precacheAndRoute(self.__WB_MANIFEST || []);

// Single-page app: every in-app navigation (including a deep link opened
// offline) is served the precached index.html shell. `injectManifest` does not
// add this automatically the way the generated SW would. /api/ is excluded so
// data requests still hit the network / their own handler below.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api\//],
  }),
);

// API reads: serve from network, fall back to the last good response offline.
registerRoute(
  ({ url, request }) =>
    request.method === 'GET' &&
    (/^https:\/\/api\./.test(url.origin) || url.pathname.startsWith('/api/')),
  new NetworkFirst({
    cacheName: 'api-cache',
    plugins: [new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 })],
  }),
  'GET',
);

// Outbound attendance sync: failed POSTs are queued and replayed on reconnect.
registerSyncQueue();
// ...and a dedicated Background Sync tag that drains the durable Dexie backlog
// even when no request ever failed at the transport layer.
registerDurableQueueSync();

// Let the app trigger an immediate replay attempt (e.g. when the online event
// fires in the page) by posting { type: 'REPLAY_SYNC' } to the SW.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'REPLAY_SYNC') {
    event.waitUntil(
      (async () => {
        const { backgroundSyncPlugin } = await import('../workers/syncQueue');
        await backgroundSyncPlugin.queue.replayRequests().catch(() => {});
        await drainSyncQueue().catch(() => {});
      })(),
    );
  }
});
