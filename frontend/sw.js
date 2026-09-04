'use strict';

const CACHE = 'tomato-farm-manager-v18';
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
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(
          keys.filter(function (k) { return k !== CACHE; })
              .map(function (k) { return caches.delete(k); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

// ネットワーク優先・失敗時にキャッシュ（更新が即座に届き、オフラインでも開ける）
// cache: 'no-cache' でHTTPキャッシュを素通りし、毎回サーバーに更新確認する。
// GAS（script.google.com）宛のAPI通信はここでは扱わず素通しする
// （他オリジンGETをキャッシュ経由で処理するとオフライン時に空レスポンスになりうるため）
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  if (e.request.url.indexOf(self.location.origin) !== 0) return;

  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(function (res) {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      })
      .catch(function () {
        return caches.match(e.request, { ignoreSearch: true });
      })
  );
});
