export function registerServiceWorker() {
  if (typeof window === 'undefined') return;

  // In dev, remove any worker left over from a build or preview on this origin.
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
