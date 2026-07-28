// Registers public/sw.js. Production only — in `make dev` a service worker
// would sit in front of Vite's HMR transport and serve stale modules.
export function registerServiceWorker() {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .catch((err) => console.error('[sw] registration failed', err));
  });
}
