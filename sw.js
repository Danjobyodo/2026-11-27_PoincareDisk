const CACHE_NAME = 'h2-hyperbolic-lab-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/dd.js',
  './js/hyperbolic.js',
  './js/theorems.js',
  './js/renderer.js',
  './js/app.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) {
        // Stale-while-revalidate when online
        event.waitUntil(
          fetch(event.request)
            .then((resp) => {
              if (resp && resp.ok && resp.type === 'basic') {
                return caches.open(CACHE_NAME).then((c) => c.put(event.request, resp.clone()));
              }
            })
            .catch(() => {})
        );
        return cached;
      }
      return fetch(event.request)
        .then((resp) => {
          if (resp && resp.ok && resp.type === 'basic') {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
          }
          return resp;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
