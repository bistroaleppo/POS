const CACHE_NAME = 'bistro-pos-v1.0.4';
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
  './assets/js/firebase-auth-compat.js',
  './assets/js/firebase-firestore-compat.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Service Worker: Caching App Shell static assets');
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
            console.log('Service Worker: Purging outdated cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only intercept HTTP/HTTPS GET requests
  if (event.request.method !== 'GET') return;

  const requestUrl = event.request.url;

  // Let Firebase API requests bypass Service Worker caching directly to Firebase SDK
  if (
    requestUrl.includes('firestore.googleapis.com') ||
    requestUrl.includes('identitytoolkit.googleapis.com') ||
    requestUrl.includes('securetoken.googleapis.com')
  ) {
    return;
  }

  // Cache-First with Stale-While-Revalidate Strategy for instant 0ms app rendering
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            networkResponse.type === 'basic'
          ) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      // Serve from cache immediately if present, otherwise fetch from network
      return cachedResponse || fetchPromise;
    })
  );
});
