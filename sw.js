// Service worker: keeps the board running through network outages and
// reboots without internet.
//
//   Page code, config, images, fonts → network first, cached copy if offline
//   Background videos (.mp4)         → downloaded once in full, then served
//                                      from cache (with byte-range support)
//   Other sites (calendar Worker,    → not touched; the page keeps its own
//   weather APIs)                      last-good copies in localStorage
//
// Bump CACHE_VERSION only if the caching logic itself changes.
const CACHE_VERSION = 'v1';
const SHELL_CACHE = 'shell-' + CACHE_VERSION;
const MEDIA_CACHE = 'media-' + CACHE_VERSION;
const MAX_VIDEOS = 2; // current month + one spare

const SHELL = [
  './', 'index.html', 'styles.css', 'config.js', 'ics.js', 'weather.js', 'script.js',
  'announcements.json', 'assets/logo.png', 'assets/theme-graphic.png',
  'assets/fonts/inter-latin-wght-normal.woff2'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== MEDIA_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('.mp4')) {
    event.respondWith(serveVideo(req));
  } else {
    event.respondWith(networkFirst(req, event));
  }
});

async function networkFirst(req, event) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      event.waitUntil(cache.put(stripSearch(req), copy));
    }
    return res;
  } catch (err) {
    const hit = await cache.match(stripSearch(req)) ||
                (req.mode === 'navigate' ? await cache.match('index.html') : null);
    if (hit) return hit;
    throw err;
  }
}

// Cache entries are keyed without query strings so ?screen=… / ?date=…
// page URLs still find the cached page when offline.
function stripSearch(req) {
  const u = new URL(req.url);
  u.search = '';
  return u.href;
}

// ── Video ───────────────────────────────────────────────────────────────────
// <video> asks for byte ranges, and range (206) responses can't be cached.
// So the first request downloads the whole file once and caches it; every
// request after that is answered by slicing the cached file.

const inflight = new Map();

async function serveVideo(req) {
  const key = stripSearch(req);
  const cache = await caches.open(MEDIA_CACHE);
  let cached = await cache.match(key);

  if (!cached) {
    try {
      if (!inflight.has(key)) {
        inflight.set(key, (async () => {
          const res = await fetch(key, { cache: 'no-store' });
          if (!res.ok || res.status !== 200) throw new Error('HTTP ' + res.status);
          await cache.put(key, res);
          await pruneVideos(cache, key);
        })().finally(() => inflight.delete(key)));
      }
      await inflight.get(key);
      cached = await cache.match(key);
    } catch (err) {
      return fetch(req); // let the network (or the page's error handler) deal with it
    }
  }
  return rangeResponse(req, cached);
}

async function pruneVideos(cache, keep) {
  const keys = await cache.keys();
  const others = keys.filter(r => r.url !== keep);
  // Oldest entries first (cache.keys() preserves insertion order).
  while (others.length > MAX_VIDEOS - 1) await cache.delete(others.shift());
}

async function rangeResponse(req, cached) {
  const blob = await cached.blob();
  const type = cached.headers.get('Content-Type') || 'video/mp4';
  const size = blob.size;
  const range = req.headers.get('Range');
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());

  if (!m || (m[1] === '' && m[2] === '')) {
    return new Response(blob, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
    });
  }

  let start, end;
  if (m[1] === '') { start = Math.max(0, size - +m[2]); end = size - 1; }
  else { start = +m[1]; end = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1); }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1, type), {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes'
    }
  });
}
