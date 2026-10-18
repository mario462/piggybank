// Offline support: keep the app shell cached so it opens without signal.
// API calls are never cached; the app keeps its own copy of the data.
const VERSION = 'piggy-v3';
const SHELL = [
  '/', '/css/app.css', '/js/app.js', '/js/ledger.js', '/js/store.js', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/apple-touch-icon.png', '/icons/icon-192.png',
  '/fonts/geist-300.woff2', '/fonts/geist-400.woff2', '/fonts/geist-500.woff2', '/fonts/geist-mono-400.woff2', '/fonts/geist-mono-500.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    // Network first so an expired sign-in can redirect to the login page; cached page when offline.
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok && res.type === 'basic') caches.open(VERSION).then(c => c.put('/', res.clone()));
      return res;
    }).catch(() => caches.match('/')));
    return;
  }
  // Static files: serve from cache, refresh in the background.
  e.respondWith(caches.match(e.request).then(hit => {
    const net = fetch(e.request).then(res => {
      if (res.ok && res.type === 'basic') caches.open(VERSION).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
