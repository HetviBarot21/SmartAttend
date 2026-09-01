/* eslint-env serviceworker */
/**
 * Custom service worker (vite-plugin-pwa `injectManifest` strategy).
 *
 * Replaces the previous auto-generated SW so we can host the outbound sync
 * queue (src/workers/syncQueue.js) in the worker. Everything the old
 * generateSW config did - precache the app shell, NetworkFirst for API GETs -
 * is reproduced here.
 */

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

import { registerSyncQueue } from '../workers/syncQueue';

// `registerType: 'autoUpdate'` expects the new SW to take over immediately.
self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

// Injected at build time by vite-plugin-pwa.
precacheAndRoute(self.__WB_MANIFEST || []);

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

// Let the app trigger an immediate replay attempt (e.g. when the online event
// fires in the page) by posting { type: 'REPLAY_SYNC' } to the SW.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'REPLAY_SYNC') {
    event.waitUntil(
      (async () => {
        const { backgroundSyncPlugin } = await import('../workers/syncQueue');
        await backgroundSyncPlugin.queue.replayRequests().catch(() => {});
      })(),
    );
  }
});
