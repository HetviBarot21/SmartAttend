/**
 * Service worker registration for the offline-first PWA.
 *
 * vite-plugin-pwa generates the Workbox service worker and exposes this
 * `virtual:pwa-register` helper at build time. In dev the virtual module still
 * resolves (registration is a no-op unless `devOptions.enabled` is set), so the
 * import is safe in every mode. Guarded in a try/catch so a browser without
 * service-worker support - or a test bundler that does not know the virtual
 * module - cannot break first paint.
 */
export function registerServiceWorker() {
  if (typeof window === 'undefined') return;

  // In dev we serve no service worker (devOptions.enabled: false), but a build
  // or `vite preview` run against the same origin leaves one registered and
  // controlling the page - which then intercepts /api calls the Vite proxy
  // should handle and serves stale precached assets. Tear any such worker down.
  if (import.meta.env.DEV && 'serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then((regs) => {
        for (const reg of regs) reg.unregister();
        if (regs.length > 0) {
          console.info(`[pwa] dev mode - unregistered ${regs.length} stale service worker(s)`);
        }
      })
      .catch(() => {});
    return;
  }

  import('virtual:pwa-register')
    .then(({ registerSW }) => {
      registerSW({
        immediate: true,
        onOfflineReady() {
          // The app shell is cached; the teacher can now open it with no network.
          console.info('[pwa] offline ready - app shell cached');
        },
        onRegisterError(err) {
          console.warn('[pwa] service worker registration failed', err);
        }
      });
    })
    .catch((err) => {
      console.warn('[pwa] service worker registration unavailable', err);
    });
}
