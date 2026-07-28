/* yt2txt service worker — hand-written on purpose.
 *
 * Vite emits content-hashed bundles, so there is no precache manifest to keep
 * in sync: hashed files under /assets/ are immutable (cache-first) and
 * everything else is decided at request time. Nothing here needs a build step.
 *
 * Bump VERSION to force every client to drop its caches on the next activate.
 */

const VERSION = 'v1';
const SHELL_CACHE = `yt2txt-shell-${VERSION}`;
const ASSET_CACHE = `yt2txt-assets-${VERSION}`;
const CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE];

// The SPA shell. Every route (/, /history, /people, /summary/*, /share) is
// served from this one document, so caching it under '/' covers them all.
const SHELL_URL = '/';

const PRECACHE = [
  SHELL_URL,
  '/manifest.json',
  '/yt2txt.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Individually, so one 404 (e.g. a renamed icon) cannot fail the install.
    await Promise.all(PRECACHE.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
        console.warn('[sw] precache skipped', url, err);
      })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith('yt2txt-') && !CURRENT_CACHES.includes(name))
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

// Network-first: the shell must be able to change on deploy. The cached copy
// is only a fallback, so an offline launch still boots the app.
async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      // Key on SHELL_URL, not the request: /summary/<id> and /share?... all
      // return the same document and must not each get their own entry.
      cache.put(SHELL_URL, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(SHELL_URL);
    if (cached) return cached;
    throw err;
  }
}

// Hashed filenames never change contents — serve from cache, fetch on miss.
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

// Icons, the manifest, the favicon: serve fast, refresh in the background.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch((err) => {
      if (cached) return cached;
      throw err;
    });
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never touch POSTs — that includes every Lambda summarise call.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin (the Lambda Function URL, Google Fonts) goes straight to the
  // network: summaries must never be served stale, and opaque font responses
  // are not worth managing here.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

// Lets the page trigger an immediate update instead of waiting for a reload.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
