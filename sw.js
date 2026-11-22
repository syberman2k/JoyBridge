const APP_VERSION = 'v3.04';
const SHELL_CACHE = `joybridge-shell-${APP_VERSION}`;
const RUNTIME_CACHE = `joybridge-runtime-${APP_VERSION}`;
// Static name so downloaded video/audio persists across app version updates
const MEDIA_CACHE = 'joybridge-media-v1';

const VALID_CACHES = [SHELL_CACHE, RUNTIME_CACHE, MEDIA_CACHE];
const MAX_MEDIA_ENTRIES = 30;

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './LOGO_Circular.png',
  './ShareNWJoyBridgeQRCode.png',
  './AppBKGrnd.jpg',
  './VenuePhoto.png',
  './VideoPoster.jpg'
];

// ---------------------------------------------------------------------------
// 1. INSTALL: Precache the core App Shell
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// ---------------------------------------------------------------------------
// 2. ACTIVATE: Clean up outdated version caches while preserving MEDIA_CACHE
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
// 3. FETCH: Route requests by resource type
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET' || !request.url.startsWith('http')) {
    return;
  }

  const url = new URL(request.url);

  // A. Audio & Video (Persistent MEDIA_CACHE + Safari/iOS Range support)
  if (isMediaRequest(request, url)) {
    event.respondWith(handleMediaRequest(request));
    return;
  }

  // B. HTML Navigation (Network-First, falling back to cached index.html)
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(request));
    return;
  }

  // C. Core Precached Shell Assets (Cache-First)
  if (isPrecachedAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request))
    );
    return;
  }

  // D. Same-Origin & CDN Assets like Tailwind / FontAwesome (Stale-While-Revalidate)
  if (
    url.origin === self.location.origin ||
    url.hostname === 'cdn.tailwindcss.com' ||
    url.hostname === 'cdnjs.cloudflare.com'
  ) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
  }
});

// ---------------------------------------------------------------------------
// Helpers & Strategy Handlers
// ---------------------------------------------------------------------------

function isMediaRequest(request, url) {
  return (
    request.destination === 'audio' ||
    request.destination === 'video' ||
    /\.(mp3|m4a|wav|ogg|mp4|webm)(\?.*)?$/i.test(url.pathname)
  );
}

function isPrecachedAsset(url) {
  if (url.origin !== self.location.origin) return false;
  return PRECACHE_URLS.some((path) => {
    const resolved = new URL(path, self.registration.scope).pathname;
    return resolved === url.pathname;
  });
}

async function handleNavigationRequest(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('./index.html', networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    const cachedExact = await caches.match(request);
    if (cachedExact) return cachedExact;

    const cachedShell = await caches.match('./index.html');
    return cachedShell || new Response('Offline - Please reconnect once to cache JoyBridge.', { status: 503 });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);

  const networkPromise = fetch(request)
    .then((networkResponse) => {
      if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    })
    .catch(() => null);

  return cachedResponse || (await networkPromise) || new Response('', { status: 504 });
}

// Media handler with HTTP Range support (required for Safari/iOS <video>/<audio>)
async function handleMediaRequest(request) {
  const cache = await caches.open(MEDIA_CACHE);
  const cleanUrl = request.url;
  let cachedResponse = await cache.match(cleanUrl);

  // Only auto-cache full non-range fetches; Range streams are cached via the "Save Offline" button
  if (!cachedResponse) {
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) {
      return fetch(request);
    }

    try {
      const fullResponse = await fetch(cleanUrl);
      if (fullResponse.status === 200) {
        await cache.put(cleanUrl, fullResponse.clone());
        await trimCache(MEDIA_CACHE, MAX_MEDIA_ENTRIES);
        cachedResponse = fullResponse;
      } else {
        return fullResponse;
      }
    } catch (err) {
      return new Response('Media unavailable offline', { status: 503 });
    }
  }

  const rangeHeader = request.headers.get('Range');
  if (rangeHeader && cachedResponse) {
    return createPartialResponse(cachedResponse, rangeHeader);
  }

  return cachedResponse;
}

async function createPartialResponse(fullResponse, rangeHeader) {
  const buffer = await fullResponse.arrayBuffer();
  const totalBytes = buffer.byteLength;

  const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  if (!match) {
    return new Response(buffer, {
      status: 200,
      headers: fullResponse.headers
    });
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

async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxItems) {
    await cache.delete(keys[0]);
    return trimCache(cacheName, maxItems);
  }
}
