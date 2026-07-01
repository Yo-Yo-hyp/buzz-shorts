// BUZZ SHORTS - service worker
// HTML(アプリ本体)は「まずネット、失敗したらキャッシュ」に変更。
// アイコンなど滅多に変わらない静的ファイルだけキャッシュ優先にする。
// data(shorts.json)は引き続きネット優先。

const CACHE_NAME = 'buzzshorts-v3'; // 更新のたびにこの番号を上げると、古いキャッシュを確実に破棄できる
const SHELL_FILES = [
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

  // データファイルは「まずネット、失敗したらキャッシュ」（更新頻度が高いため）
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

  // HTML本体（ページ遷移・index.html）も「まずネット、失敗したらキャッシュ」
  // ここをキャッシュ優先にしていたのが「更新されない」問題の原因だった
  if (event.request.mode === 'navigate' || url.pathname.endsWith('index.html') || url.pathname.endsWith('/')) {
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

  // それ以外（アイコンなど、滅多に変わらない静的ファイル）は「まずキャッシュ、なければネット」
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
