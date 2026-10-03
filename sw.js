self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  // Pass-through fetch to satisfy Chrome PWA install requirements
  e.respondWith(fetch(e.request).catch(() => new Response('Offline')));
});