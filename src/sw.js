/* Gamelan Practice service worker — offline app shell.
   The three pages are fully self-contained (analysis engine / DSP inlined,
   system fonts, no CDN), so caching the HTML plus the manifest and icons is the
   whole app. User audio is loaded from local files at runtime, never fetched,
   so nothing else needs caching for offline use.

   Bump CACHE when any shell file changes, so clients pick up the new version. */
const CACHE = 'gamelan-practice-v1';
const SHELL = [
  './',
  './index.html',
  './score-format.html',
  './tone-prep.html',
  './manifest.webmanifest',
  './icon.svg',
  './gong-192.png',
  './gong-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // allSettled so a shell entry that is briefly absent cannot abort the rest.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req)
        .then((res) => {
          if (res && res.ok && new URL(req.url).origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    )
  );
});
