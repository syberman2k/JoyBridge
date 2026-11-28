// NW JoyBridge Service Worker v3.06
const SHELL_VERSION = 'v3.07';
const SHELL_CACHE = `joybridge-shell-${SHELL_VERSION}`;
const RUNTIME_CACHE = `joybridge-runtime-${SHELL_VERSION}`;
const PERSISTENT_MEDIA_CACHE = 'joybridge-media-v1';

const VALID_CACHES = [SHELL_CACHE, RUNTIME_CACHE, PERSISTENT_MEDIA_CACHE];

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './LOGO_Circular.png',
  './AppBKGrnd.jpg',
  './VideoPoster.jpg',
  './VenuePhoto.png',
  './ShareNWJoyBridgeQRCode.png',
  './WelcomeVideoQRCode.jpg'
];

// ---------------------------------------------------------------------------
// 1. INSTALL: Precache App Shell & Visual Assets
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      // Cache individually so one optional image never blocks offline readiness
      await Promise.allSettled(
        PRECACHE_URLS.map((url) => cache.add(url))
      );
    })
  );
  self.skipWaiting();
});

// ---------------------------------------------------------------------------
// 2. ACTIVATE: Purge outdated shell/runtime versions while keeping saved video
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => !VALID_CACHES.includes(key))
          .map((oldKey) => caches.delete(oldKey))
      )
    ).then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// 3. FETCH: Route requests cleanly
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET' || !request.url.startsWith('http')) {
    return;
  }

  const url = new URL(request.url);

  // A. Bypass cache completely for live connectivity pings (?ping=...)
  if (url.searchParams.has('ping')) {
    event.respondWith(fetch(request));
    return;
  }

  // B. Video & Audio files (handles Safari/iOS Range requests from joybridge-media-v1)
  if (isMediaRequest(request, url)) {
    event.respondWith(handleMediaRequest(request));
    return;
  }

  // C. HTML Navigation (Network-First -> falls back to cached index.html)
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(request));
    return;
  }

  // D. Same-origin static assets (Cache-First with background refresh)
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirstWithRefresh(request));
    return;
  }

  // E. External CDN assets (Tailwind, FontAwesome, QR API) -> Stale-While-Revalidate
  event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
});

function isMediaRequest(request, url) {
  return (
    request.destination === 'audio' ||
    request.destination === 'video' ||
    /\.(mp3|m4a|wav|ogg|mp4|webm)(\?.*)?$/i.test(url.pathname)
  );
}

async function handleNavigationRequest(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('./index.html', networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    const cachedIndex = await caches.match('./index.html') || await caches.match('./');
    return cachedIndex || new Response('Offline', { status: 503 });
  }
}

async function cacheFirstWithRefresh(request) {
  const shellCache = await caches.open(SHELL_CACHE);
  const cached = await shellCache.match(request);

  const networkFetch = fetch(request)
    .then((res) => {
      if (res && res.ok) {
        shellCache.put(request, res.clone());
      }
      return res;
    })
    .catch(() => null);

  return cached || (await networkFetch) || new Response('', { status: 504 });
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(request, res.clone());
      }
      return res;
    })
    .catch(() => null);

  return cached || (await networkFetch) || new Response('', { status: 504 });
}

// Serve saved video from joybridge-media-v1 with byte-range slicing for iOS & Chrome
async function handleMediaRequest(request) {
  const cache = await caches.open(PERSISTENT_MEDIA_CACHE);
  const cleanUrl = new URL(request.url);
  cleanUrl.search = '';
  const cachedResponse = await cache.match(cleanUrl.href);

  if (cachedResponse) {
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) {
      return createPartialResponse(cachedResponse, rangeHeader);
    }
    return cachedResponse;
  }

  // Not saved offline yet -> stream directly from network without auto-caching large MP4s
  return fetch(request);
}

async function createPartialResponse(fullResponse, rangeHeader) {
  const buffer = await fullResponse.arrayBuffer();
  const totalBytes = buffer.byteLength;

  const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  if (!match) {
    return new Response(buffer, { status: 200, headers: fullResponse.headers });
  }

  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), totalBytes - 1) : totalBytes - 1;

  if (start >= totalBytes || start > end) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${totalBytes}` }
    });
  }

  const sliced = buffer.slice(start, end + 1);
  const headers = new Headers(fullResponse.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${totalBytes}`);
  headers.set('Content-Length', String(sliced.byteLength));
  headers.set('Accept-Ranges', 'bytes');

  return new Response(sliced, {
    status: 206,
    statusText: 'Partial Content',
    headers
  });
}
