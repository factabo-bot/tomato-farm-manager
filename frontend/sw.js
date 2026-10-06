'use strict';

// アプリは /frontend/ から /app/ に移った（2026-10-06）。
// Android の Chrome が、アンインストール済みの /frontend/ のアプリを「インストール済み」と
// 覚えたまま入れ直せなくなったため、範囲の違う場所へ移して回避した。
// 古いService Workerが端末のキャッシュから旧画面を出し続けないよう、これに差し替わったら
// 旧キャッシュを捨てて登録を解除し、開いている画面を /app/ へ送る。
// 記録（localStorage）は同じサイト内なので /app/ にそのまま引き継がれる。

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        // /app/ 側のキャッシュ（tomato-farm-manager-app-…）と、同居する別アプリには触らない
        return Promise.all(
          keys.filter(function (k) { return /^tomato-farm-manager-v\d+$/.test(k); })
              .map(function (k) { return caches.delete(k); })
        );
      })
      .then(function () { return self.registration.unregister(); })
      .then(function () { return self.clients.matchAll({ type: 'window' }); })
      .then(function (clients) {
        clients.forEach(function (c) {
          c.navigate(c.url.replace('/frontend/', '/app/'));
        });
      })
  );
});
