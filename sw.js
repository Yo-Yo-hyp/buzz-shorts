// BUZZ SHORTS - service worker
// アプリの「ガラ」はキャッシュ優先、データ(shorts.json)はネット優先にする

const CACHE_NAME = 'buzzshorts-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // データファイルは「まずネット、失敗したらキャッシュ」
  if (url.pathname.endsWith('shorts.json')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // それ以外（HTML/アイコンなど）は「まずキャッシュ、なければネット」
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
