/* Service Worker：静态资源缓存 + 只读题库接口离线回退
   策略：
   - 页面导航：网络优先，断网回退到缓存的 index.html（保证总能打开）
   - 静态资源：stale-while-revalidate（先给缓存，后台更新）
   - 只读题目接口（/api/daily、/api/problems/:code、/api/meta）：网络优先 + 回填缓存，
     断网时返回最近看过的题面 —— 教室/地铁里也能翻错题
   - 其余 /api/（登录态、提交、判题）：一律放行不缓存，避免串号与脏数据
   版本号变了就换缓存名，activate 时清掉旧缓存，避免 old ?v= 资源永久驻留。 */
const VERSION = 'v3.0.1';
const STATIC_CACHE = 'mv-static-' + VERSION;
const RUNTIME_CACHE = 'mv-runtime-' + VERSION;
const API_CACHE = 'mv-api-readonly-v1';
const API_CACHE_MAX = 100;
const PRECACHE = [
  './index.html', './assets/style.css', './js/app.js', './js/api.js',
  './js/draft-store.js', './js/heatmap.js', './manifest.json', './assets/icon.svg'
];

/* 只读、不涉及鉴权、可安全离线的接口 */
const READONLY_API = [
  /^\/api\/meta$/,
  /^\/api\/daily$/,
  /^\/api\/problems$/,
  /^\/api\/problems\/[A-Za-z0-9-]+$/,
  /^\/api\/forum(\/\d+)?$/
];

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
        if (k !== STATIC_CACHE && k !== RUNTIME_CACHE && k !== API_CACHE) return caches.delete(k);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/** 只保留最近 API_CACHE_MAX 条题目缓存，避免 Cache Storage 无限膨胀 */
function trimApiCache(cache) {
  return cache.keys().then(function (reqs) {
    if (reqs.length <= API_CACHE_MAX) return null;
    return Promise.all(reqs.slice(0, reqs.length - API_CACHE_MAX).map(function (r) {
      return cache.delete(r);
    }));
  }).catch(function () {});
}

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/uploads/') >= 0) return;

  /* 只读接口：网络优先，成功就回填；失败回退缓存 */
  if (url.pathname.indexOf('/api/') === 0) {
    const readonly = READONLY_API.some(function (re) { return re.test(url.pathname); });
    if (!readonly) return; // 其余接口完全不拦截
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(API_CACHE).then(function (c) {
            return c.put(req, copy).then(function () { return trimApiCache(c); });
          }).catch(function () {});
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          if (hit) return hit;
          return new Response(JSON.stringify({ ok: false, offline: true, error: '当前离线，且这道题还没缓存过' }), {
            status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' }
          });
        });
      })
    );
    return;
  }

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
