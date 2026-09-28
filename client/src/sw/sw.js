/* eslint-env serviceworker */
/** Custom service worker (vite-plugin-pwa `injectManifest`). */

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

import { registerSyncQueue, registerDurableQueueSync } from '../workers/syncQueue';
import { drainSyncQueue } from '../services/syncService';

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

precacheAndRoute(self.__WB_MANIFEST || []);

// Serve the cached index.html for every navigation except /api/.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api\//],
  }),
);

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

registerSyncQueue();
registerDurableQueueSync();

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
