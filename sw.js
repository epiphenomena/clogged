/*
 * Clogged service worker — deliberately minimal while the game is being tweaked.
 *
 * Nothing is precached and every request goes to the network first, so an edit
 * shows up on the next load without anyone clearing a cache by hand. A copy of
 * each successful response is kept only as an offline fallback, which is also
 * what keeps the app installable (the install prompt needs a fetch handler that
 * can answer a navigation).
 *
 * When the game settles down, switch this back to precaching a versioned
 * asset list for a faster cold start.
 */
const CACHE = 'clogged-fallback-v3';

self.addEventListener('install', (event) => {
  // Take over straight away rather than waiting for every tab to close.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Drops the old precache from earlier versions, which would otherwise
      // keep serving stale files forever.
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => {
        if (hit) return hit;
        // An unvisited page while offline still gets the app shell.
        return req.mode === 'navigate' ? caches.match('./index.html') : undefined;
      }))
  );
});
