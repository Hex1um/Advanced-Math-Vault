/* Service Worker：只缓存静态资源，接口一律走网络。
   策略：
   - /api/ 与跨域请求：直接放行，不拦截（缓存 API 会导致登录态与数据错乱）
   - 页面导航：网络优先，断网时回退到缓存的 index.html
   - 其余同源静态资源：stale-while-revalidate（先给缓存，后台更新）
   版本号变了就换缓存名，activate 时清掉旧缓存，避免 old ?v= 资源永久驻留。 */
const VERSION = 'v1.5.1';
const STATIC_CACHE = 'mv-static-' + VERSION;
const RUNTIME_CACHE = 'mv-runtime-' + VERSION;
const PRECACHE = ['./index.html', './assets/style.css', './js/app.js', './manifest.json', './assets/icon.svg'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(function (c) { return c.addAll(PRECACHE); })
      .catch(function () { /* 预缓存失败不阻塞安装 */ })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== STATIC_CACHE && k !== RUNTIME_CACHE) return caches.delete(k);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') >= 0) return;
  if (url.pathname.indexOf('/uploads/') >= 0) return;

  // 页面导航：网络优先（保证拿到新版本），断网回退缓存
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        const copy = res.clone();
        caches.open(RUNTIME_CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) { return hit || caches.match('./index.html'); });
      })
    );
    return;
  }

  // 静态资源：先缓存后更新
  event.respondWith(
    caches.match(req).then(function (hit) {
      const network = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      }).catch(function () { return hit; });
      return hit || network;
    })
  );
});
