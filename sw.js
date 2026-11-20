const CACHE_NAME = 'halation-studio-pwa-v1.6.0';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './halation-engine.js',
  './metadata-utils.js',
  './session-cache.js',
  './manifest.webmanifest',
  './assets/icons/icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/examples/example1-input.png',
  './assets/examples/example1-expected.png',
  './assets/examples/example2-input.png',
  './assets/examples/example2-expected.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => (key !== CACHE_NAME ? caches.delete(key) : Promise.resolve()))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Same-origin requests: Network-first for HTML/JS/CSS/manifest (always fresh online, full offline fallback)
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          const networkResponse = await fetch(request);
          if (networkResponse && networkResponse.ok) {
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        } catch (_) {
          const exactMatch = await cache.match(request);
          if (exactMatch) return exactMatch;

          const ignoreSearchMatch = await cache.match(request, { ignoreSearch: true });
          if (ignoreSearchMatch) return ignoreSearchMatch;

          if (request.mode === 'navigate') {
            const indexFallback = await cache.match('./index.html', { ignoreSearch: true });
            if (indexFallback) return indexFallback;
          }
          throw new Error('Offline and resource not found in PWA cache');
        }
      })()
    );
  }
});
