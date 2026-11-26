/* 路由与启动 */
(function () {
  'use strict';

  const St = window.API.State;
  let cleanup = null;

  function parseRoute() {
    const raw = (location.hash || '').replace(/^#/, '') || '/problems';
    const qi = raw.indexOf('?');
    const path = qi >= 0 ? raw.slice(0, qi) : raw;
    const params = {};
    if (qi >= 0) {
      new URLSearchParams(raw.slice(qi + 1)).forEach(function (v, k) { params[k] = v; });
    }
    const seg = path.split('/').filter(Boolean);

    if (!seg.length) return { name: 'library', params: params, nav: 'problems' };
    if (seg[0] === 'problems') return { name: 'library', params: params, nav: 'problems' };
    if (seg[0] === 'problem') return { name: 'problem', params: Object.assign({ code: seg[1] || '' }, params), nav: 'problems' };
    if (seg[0] === 'daily') return { name: 'daily', params: params, nav: 'daily' };
    if (seg[0] === 'forum' && seg[1]) return { name: 'post', params: Object.assign({ id: seg[1] }, params), nav: 'forum' };
    if (seg[0] === 'forum') return { name: 'forum', params: params, nav: 'forum' };
    if (seg[0] === 'generate') return { name: 'generate', params: params, nav: 'generate' };
    if (seg[0] === 'wrong') return { name: 'wrongbook', params: params, nav: 'wrong' };
    if (seg[0] === 'paper') return { name: 'paper', params: params, nav: 'paper' };
    if (seg[0] === 'exam') return { name: 'exam', params: params, nav: 'paper' };
    if (seg[0] === 'submit') return { name: 'submit', params: params, nav: 'submit' };
    if (seg[0] === 'analytics') return { name: 'analytics', params: params, nav: 'analytics' };
    if (seg[0] === 'collections' && seg[1]) return { name: 'collection', params: Object.assign({ id: seg[1] }, params), nav: 'collections' };
    if (seg[0] === 'collections') return { name: 'collections', params: params, nav: 'collections' };
    if (seg[0] === 'practice') return { name: 'practice', params: params, nav: 'analytics' };
    if (seg[0] === 'my') return { name: 'my', params: params, nav: '' };
    if (seg[0] === 'admin') return { name: 'admin', params: params, nav: '' };
    return { name: 'notfound', params: params, nav: '' };
  }

  function render() {
    const route = parseRoute();
    St.route = route;
    window.UI.setActiveNav(route.nav);

    if (cleanup) { try { cleanup(); } catch (e) {} cleanup = null; }

    const el = document.getElementById('view');
    el.innerHTML = '';
    document.title = ((window.MV_CONFIG && window.MV_CONFIG.siteName) || '数海晴岸') + ' · 高等数学好题收藏室';

    const view = window.Views[route.name];
    if (!view) {
      el.innerHTML = '<div class="empty" style="margin-top:40px"><b>页面不存在</b>检查一下链接，或者回题库看看。'
        + '<div style="margin-top:14px"><a class="btn" href="#/problems">回到题库</a></div></div>';
      return;
    }

    const ret = view(el, route.params);
    if (typeof ret === 'function') cleanup = ret;
    if (window.Chat && route.name !== 'problem') { /* 保持已打开的对话不受影响 */ }
  }

  function updateFooter() {
    const el = document.getElementById('footerStats');
    if (!el) return;
    const s = St.stats || {};
    el.textContent = '收录 ' + (s.problems || 0) + ' 题 · ' + (s.users || 0) + ' 位同学 · ' + (s.mainTags || 0) + ' 个主标签 / ' + (s.tags || 0) + ' 个子标签';
  }

  /* 元信息缓存：弱网/后端冷启动时，先用上一次的统计与标签树把页面画出来，
     真正的数据到货后再局部刷新，避免「白屏等一个请求」。 */
  const META_CACHE_KEY = 'mv_meta_cache';
  const META_CACHE_TTL = 10 * 60 * 1000;

  function readMetaCache() {
    try {
      const raw = sessionStorage.getItem(META_CACHE_KEY);
      if (!raw) return null;
      const box = JSON.parse(raw);
      if (!box || !box.at || Date.now() - box.at > META_CACHE_TTL) return null;
      return box.meta || null;
    } catch (e) { return null; }
  }

  function writeMetaCache(meta) {
    try {
      sessionStorage.setItem(META_CACHE_KEY, JSON.stringify({ at: Date.now(), meta: meta }));
    } catch (e) {}
  }

  async function refreshMeta() {
    try {
      const meta = await window.API.get('/api/meta');
      St.applyMeta(meta);
      writeMetaCache(meta);
    } catch (e) {
      console.error('[app] meta 加载失败', e);
    }
  }

  /* 首屏不再 await meta：先渲染当前路由（列表页自己有骨架屏与缓存），
     meta 到货后通过事件总线通知已挂载的视图局部更新。 */
  async function boot() {
    const cached = readMetaCache();
    if (cached) {
      try { St.applyMeta(cached); } catch (e) {}
    }
    render();
    window.addEventListener('hashchange', render);
    refreshMeta();
  }

  St.subscribe('meta:updated', function () {
    try { window.UI.renderHeader(); } catch (e) {}
    updateFooter();
  });
  St.subscribe('auth:changed', function () {
    try { window.UI.renderHeader(); } catch (e) {}
    /* 其它标签页登录/退出后，本页重新拉一次 meta，避免页头状态与真实登录态不一致 */
    refreshMeta();
  });

  /* ---------------------------------------------------------- 暗色模式
     存在 localStorage；默认跟随系统（prefers-color-scheme）。 */
  const THEME_KEY = 'mv_theme';

  function readTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      if (v === 'dark' || v === 'light') return v;
    } catch (e) {}
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const btn = document.getElementById('themeBtn');
    if (btn) {
      btn.textContent = t === 'dark' ? '浅色' : '暗色';
      btn.title = t === 'dark' ? '切换到浅色' : '切换到暗色';
    }
  }

  function initTheme() {
    applyTheme(readTheme());
    const btn = document.getElementById('themeBtn');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', function () {
        const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
        applyTheme(next);
      });
    }
  }

  window.App = {
    refresh: async function () {
      await refreshMeta();
      render();
    },
    render: render,
    route: () => St.route,
    theme: { get: readTheme, set: function (t) { try { localStorage.setItem(THEME_KEY, t); } catch (e) {} applyTheme(t); } }
  };

  initTheme();

  /* PWA：只在 https 或 localhost 注册。失败不影响使用（file:// 与内网 http 都会抛）。 */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function (e) {
        console.warn('[pwa] Service Worker 注册失败（不影响使用）', e && e.message);
      });
    });
  }

  /* 全局兜底：任何漏网的异常都提示一次，不让页面停在半截或静默失败 */
  (function guard() {
    let last = 0;
    const report = function (kind, msg) {
      const now = Date.now();
      if (now - last < 1500) return;      // 同一波错误只提示一次
      last = now;
      console.error('[' + kind + ']', msg);
      try {
        if (window.UI && window.UI.toast) window.UI.toast('操作出错了：' + String(msg).slice(0, 60), 'err');
      } catch (e) {}
    };
    window.addEventListener('error', function (e) {
      if (!e || !e.message) return;
      // 图片/脚本加载失败也走这里，噪音大，只报脚本错误
      if (e.target && e.target !== window) return;
      report('error', e.message);
    });
    window.addEventListener('unhandledrejection', function (e) {
      const r = e && e.reason;
      report('promise', (r && (r.message || r)) || '未知错误');
    });
  })();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
