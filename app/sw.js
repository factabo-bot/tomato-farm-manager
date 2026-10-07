'use strict';

const CACHE = 'tomato-farm-manager-app-v43';
const ASSETS = [
  './',
  './index.html',
  './work.html',
  './pesticide.html',
  './growth.html',
  './history.html',
  './fertilizer.html',
  './styles.css',
  './fertilizer.css',
  './config.js',
  './masters-default.js',
  './common.js',
  './index.js',
  './work.js',
  './pesticide.js',
  './growth.js',
  './history.js',
  './fertilizers-chem.js',
  './fertilizer.js',
  './fertilizer-ui.js',
  './manifest.json',
  './icons/tomato-clear-192.png',
  './icons/tomato-clear-512.png',
  './icons/apple-touch-icon-clear.png',
  './icons/favicon-clear-32.png',
  './icons/tab-home.png',
  './icons/tab-work.png',
  './icons/tab-spray.png',
  './icons/tab-growth.png',
  './icons/tab-fertilizer.png',
  './icons/tab-history.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      // cache:'reload' でブラウザのHTTPキャッシュを素通りする。GitHub Pages は max-age=600 なので、
      // 素の addAll だと直前に開いた画面の古いHTMLが新しい版のキャッシュに混ざる（2026-10-06 作業画面で発生）
      .then(function (c) {
        return c.addAll(ASSETS.map(function (u) { return new Request(u, { cache: 'reload' }); }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(
          // 同じ factabo-bot.github.io に別アプリ（routine-board）が同居しているので、
          // このアプリの名前で始まる古いキャッシュだけ消す
          keys.filter(function (k) { return k.indexOf('tomato-farm-manager') === 0 && k !== CACHE; })
              .map(function (k) { return caches.delete(k); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

// インストール済みの画面は端末から即表示。更新は新しいSWのインストールで一式入れ替える。
// GAS（script.google.com）宛のAPI通信はここでは扱わず素通しする
// （他オリジンGETをキャッシュ経由で処理するとオフライン時に空レスポンスになりうるため）
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  if (e.request.url.indexOf(self.location.origin) !== 0) return;

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (cached) {
      if (cached) return cached;
      return fetch(e.request, { cache: 'no-cache' })
      .then(function (res) {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      })
      .catch(function () {
        return caches.match(e.request, { ignoreSearch: true });
      });
    })
  );
});
