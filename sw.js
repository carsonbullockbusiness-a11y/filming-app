// Offline shell for Grok Film. Bump VERSION whenever app files change.
const VERSION = 'grok-film-v0.3.0';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './shared.js', './store.js', './uploader.js', './effects.js', './segments.js', './mp4join.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'grok-film-cdn').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // uploads go straight to the network
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // Network first (so updates show up right away), cache as fallback for offline / bad signal.
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    // Green-screen model + runtime: cache after first download.
    e.respondWith(
      caches.open('grok-film-cdn').then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) c.put(req, res.clone());
        return res;
      })))
    );
  }
});
