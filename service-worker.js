const CACHE_NAME = 'Restaurant-pos-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './finance.html',
  './menu.html',
  './style.css',
  './app.js',
  './database.js',
  './manifest.json',
  './assets/logo.png',
  './assets/logo.jpg',
  './assets/js/firebase-app-compat.js',
  './assets/js/firebase-firestore-compat.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Try network first, then fall back to cache
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});
