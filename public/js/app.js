/* 路由与启动 */
(function () {
  'use strict';

  const St = window.API.State;
  let cleanup = null;

  /* 自己的版本号直接从 <script src="app.js?v=x.y.z"> 里取，不再手工同步。
     Service Worker 用同一个值注册，这样每次发版 sw.js 的地址都会变，
     浏览器才会把它当成新脚本去装，而不是等 24 小时后再检查。 */
  const BUILD = (function () {
    try {
      const src = (document.currentScript && document.currentScript.src) || '';
      const m = src.match(/[?&]v=([0-9A-Za-z._-]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  })();

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
    if (seg[0] === 'sprint' && seg[1]) return { name: 'sprintPack', params: Object.assign({ id: seg[1] }, params), nav: 'sprint' };
    if (seg[0] === 'sprint') return { name: 'sprint', params: params, nav: 'sprint' };
    if (seg[0] === 'forum' && seg[1]) return { name: 'post', params: Object.assign({ id: seg[1] }, params), nav: 'forum' };
    if (seg[0] === 'forum') return { name: 'forum', params: params, nav: 'forum' };
    if (seg[0] === 'generate') return { name: 'generate', params: params, nav: 'generate' };
    if (seg[0] === 'wrong') return { name: 'wrongbook', params: params, nav: 'wrong' };
    if (seg[0] === 'paper') return { name: 'paper', params: params, nav: 'paper' };
    if (seg[0] === 'exam') return { name: 'exam', params: params, nav: 'paper' };
    if (seg[0] === 'submit') return { name: 'submit', params: params, nav: 'submit' };
    if (seg[0] === 'analytics') return { name: 'analytics', params: params, nav: 'analytics' };
    /* 题单功能已下线（2026-11-27）：旧链接统一回题库，不留死页 */
    if (seg[0] === 'collections') return { name: 'library', params: params, nav: 'problems' };
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
    document.title = ((window.MV_CONFIG && window.MV_CONFIG.siteName) || '数海晴岸') + ' · ' + St.subjectInfo(St.subject).brand;

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
    const bySubject = s.bySubject || {};
    const phys = bySubject.physics || 0;
    el.textContent = '收录 ' + (s.problems || 0) + ' 题'
      + (phys ? '（物理 ' + phys + ' 题）' : '')
      + ' · ' + (s.users || 0) + ' 位同学 · ' + (s.mainTags || 0) + ' 个主标签 / ' + (s.tags || 0) + ' 个子标签';
  }

  /* ---------------------------------------------------------- 学科切换
     顶栏 [ 数学 | 物理 ]。状态存在 API.State.subject 并持久化；
     切换时更新副标题、页标题、导航文案（每日一积 ↔ 每日一物），再重载当前视图。
     物理入口只有在后端 /api/meta 声明 features.physics 且确有物理题时才显示。 */
  let switchBound = false;

  function paintSubjectChrome() {
    const info = St.subjectInfo(St.subject);
    const brand = document.getElementById('brandSub');
    if (brand) brand.textContent = info.brand;
    const dailyLink = document.querySelector('[data-nav="daily"]');
    if (dailyLink) dailyLink.textContent = info.daily;
    const wrap = document.getElementById('subjectSwitch');
    if (wrap) {
      wrap.querySelectorAll('[data-subject]').forEach(function (b) {
        const on = b.getAttribute('data-subject') === St.subject;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    document.title = ((window.MV_CONFIG && window.MV_CONFIG.siteName) || '数海晴岸') + ' · ' + info.brand;
  }

  function applySubjectAvailability(meta) {
    const wrap = document.getElementById('subjectSwitch');
    if (!wrap) return;
    const feats = meta && meta.features;
    /* 只有后端「明确声明」没有物理时才隐藏。meta 还没到货、或返回的是旧后端
       （连 features 字段都没有）时保持现状 —— 以前这种情况会直接把入口藏掉，
       一次请求失败就变成「永远看不到物理」，这是最坑的一种失败方式。 */
    if (!feats) { paintSubjectChrome(); return; }
    const subjects = (meta && meta.subjects) || [];
    const phys = subjects.filter(function (x) { return x.key === 'physics'; })[0];
    const supported = feats.physics === true;
    wrap.hidden = !supported;
    const physBtn = wrap.querySelector('[data-subject="physics"]');
    if (physBtn) {
      const noContent = supported && (!phys || !phys.problems);
      physBtn.disabled = !!noContent;
      physBtn.title = noContent ? '物理题库还没有内容' : '切换到大学物理';
      /* 物理题库空了还停在物理页，会看到一片空列表，自动退回数学 */
      if (noContent && St.subject === 'physics') St.setSubject('math', { silent: true });
    }
    paintSubjectChrome();
  }

  function initSubjectSwitch() {
    const wrap = document.getElementById('subjectSwitch');
    if (!wrap || switchBound) return;
    switchBound = true;
    wrap.addEventListener('click', function (ev) {
      const btn = ev.target.closest && ev.target.closest('[data-subject]');
      if (!btn || btn.disabled) return;
      const next = btn.getAttribute('data-subject');
      if (next === St.subject) return;
      St.setSubject(next);
    });
    St.subscribe('subject:changed', function (d) {
      paintSubjectChrome();
      try { window.UI.renderHeader(); } catch (e) {}
      /* 视图自己发起的纠正（如题目页按编号前缀对齐学科）不再重渲染，
         否则会把发起方正在画的那一屏打断 */
      if (!(d && d.noRender)) render();
      if (!(d && d.silent)) window.UI.toast('已切换到' + d.info.label, 'ok');
    });
    paintSubjectChrome();
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

  /* 能力开关：后端没升级到 v2 时，隐藏「分析 / 题单」入口，避免点进去 404。
     判断依据是 /api/meta 的 features；旧后端没有该字段，视为不支持。 */
  function applyFeatureFlags(meta) {
    const feats = (meta && meta.features) || {};
    const supported = feats.analytics === true;
    document.querySelectorAll('[data-nav="analytics"]').forEach(function (a) {
      a.style.display = supported ? '' : 'none';
    });
    /* 期末突击是 v2.1.0 新增：后端没这个字段就说明还是旧实例，先藏起来 */
    document.querySelectorAll('[data-nav="sprint"]').forEach(function (a) {
      a.style.display = feats.sprint === true ? '' : 'none';
    });
    /* 离线（接口不可达，只有静态包）时把需要服务端的入口收起来；
       接口恢复后按 features 重新放开，所以这是可逆的，不是一次性关掉。 */
    /* 先把 features 落到 window 上，applyOfflineChrome 恢复入口时要用到它 */
    window.MV_FEATURES = feats;
    applyOfflineChrome(feats.static === true || (window.MV_CONFIG && window.MV_CONFIG.staticData) === true);
  }

  /* 只在「纯静态构建」或「接口不可达」时收起服务端入口。
     github.io 正常模式下这些入口全都在——功能没被砍掉，只是断网时降级。 */
  const SERVER_NAV = ['forum', 'generate', 'wrong', 'paper', 'submit', 'collections', 'analytics', 'sprint'];
  function applyOfflineChrome(isOffline) {
    const on = isOffline === true;
    SERVER_NAV.forEach(function (key) {
      document.querySelectorAll('[data-nav="' + key + '"]').forEach(function (a) {
        if (on) a.style.display = 'none';
        else {
          /* 恢复时按各自的特性开关决定，不能一律显示（例如期末突击没包时仍要藏） */
          const f = window.MV_FEATURES || {};
          if (key === 'analytics') a.style.display = f.analytics === true ? '' : 'none';
          else if (key === 'sprint') a.style.display = f.sprint === true ? '' : 'none';
          else if (key === 'collections') a.style.display = f.collections === true ? '' : 'none';
          else a.style.display = '';
        }
      });
    });
    const ua = document.getElementById('userArea');
    if (ua && on) ua.innerHTML = '<span class="small muted" title="服务器连不上，当前使用离线题库">离线只读</span>';
    document.body.classList.toggle('mv-static', on);
  }

  /* 并发去重：applyMeta 的变化会触发 refreshMeta，若不加锁，
     多路同时到达时可能叠成雪崩式请求（参见 api.js 里 auth:changed 的注释）。
     失败时退避重试两次：后端冷启动、弱网、切网瞬间都会让第一次请求直接失败，
     而 meta 拿不到就等于「学科开关不出现、标签树空白」，用户看到的是「物理没了」。 */
  let metaInflight = null;
  let metaVer = '';          // 上次拿到的标签版本号，用于轮询时走「没变化」快路径
  let lastMetaFingerprint = '';   // 后端不支持 ?v= 时，用内容指纹做兜底去重
  let lastMetaAt = 0;        // 上次成功刷新的时刻
  async function refreshMeta(attempt) {
    const n = Number(attempt) || 0;
    if (metaInflight) return metaInflight;
    metaInflight = (async function () {
      try {
        const meta = await window.API.get('/api/meta' + (metaVer ? '?v=' + encodeURIComponent(metaVer) : ''));
        lastMetaAt = Date.now();
        /* 版本号没变：服务端只回了 {unchanged:true}，标签树与统计保持原样，
           不重绘、不写缓存——这就是「实时更新」但不重复传输的做法。 */
        if (meta && meta.unchanged) return;
        if (meta && meta.v) metaVer = meta.v;
        /* 后端还没升级（不认 ?v=、也不回 v）时，用内容比对兜底：
           连续两次取回完全一样的 meta 就不重绘，避免每分钟闪一下统计条。 */
        const fingerprint = (function () {
          try { return JSON.stringify([meta && meta.stats, meta && meta.tagTrees, meta && meta.features]); }
          catch (e) { return ''; }
        })();
        if (fingerprint && fingerprint === lastMetaFingerprint) return;
        lastMetaFingerprint = fingerprint;
        St.applyMeta(meta);
        writeMetaCache(meta);
        applyFeatureFlags(meta);
        applySubjectAvailability(meta);
      } catch (e) {
        console.error('[app] meta 加载失败（第 ' + (n + 1) + ' 次）', e);
        if (n < 2) {
          setTimeout(function () { refreshMeta(n + 1); }, n === 0 ? 1500 : 4000);
        } else if (!readMetaCache()) {
          try {
            if (window.UI && window.UI.toast) {
              window.UI.toast('题库信息没加载出来：检查网络后刷新页面', 'err');
            }
          } catch (_) {}
        }
      }
    })();
    try { await metaInflight; } finally { metaInflight = null; }
  }

  /* ---- 旧外壳自愈 ----
     Service Worker 最坑的一种卡死是「旧 HTML 引旧 app.js、旧 app.js 又只预缓存旧资源」，
     用户怎么刷新都停在同一版，只能靠手动清缓存。开机 6 秒后如果学科入口仍然不存在，
     就说明外壳没更新上来：直接给一个浮层按钮，注销 SW → 清 Cache Storage →
     带新查询串重开，一次点击解决。 */
  function staleShellGuard() {
    setTimeout(function () {
      const wrap = document.getElementById('subjectSwitch');
      if (wrap && !wrap.hasAttribute('hidden')) return;
      const feats = window.MV_FEATURES;
      /* 后端明确说没有物理时不算异常，别去打扰用户 */
      if (feats && feats.physics === false) return;
      if (document.getElementById('mvStaleBar')) return;
      const bar = document.createElement('div');
      bar.id = 'mvStaleBar';
      bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:9999;'
        + 'display:flex;gap:12px;align-items:center;padding:10px 14px;border-radius:10px;'
        + 'background:#1f2329;color:#fff;font-size:13px;box-shadow:0 8px 28px rgba(0,0,0,.28)';
      const tip = document.createElement('span');
      tip.textContent = '你看到的还是旧版本页面（物理入口没有加载出来）';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '更新到最新版';
      btn.style.cssText = 'border:0;border-radius:7px;padding:6px 12px;background:#2f7cf6;color:#fff;'
        + 'font-size:13px;cursor:pointer;white-space:nowrap';
      btn.addEventListener('click', async function () {
        btn.disabled = true;
        btn.textContent = '正在更新…';
        try {
          if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(function (r) { return r.unregister(); }));
          }
          if (window.caches && caches.keys) {
            const keys = await caches.keys();
            await Promise.all(keys.map(function (k) { return caches.delete(k); }));
          }
        } catch (e) {}
        const u = new URL(location.href);
        u.searchParams.set('_u', String(Date.now()));
        location.replace(u.toString());
      });
      bar.appendChild(tip);
      bar.appendChild(btn);
      document.body.appendChild(bar);
    }, 6000);
  }

  /* 首屏不再 await meta：先渲染当前路由（列表页自己有骨架屏与缓存），
     meta 到货后通过事件总线通知已挂载的视图局部更新。 */  async function boot() {
    const cached = readMetaCache();
    if (cached) {
      try { St.applyMeta(cached); applyFeatureFlags(cached); applySubjectAvailability(cached); } catch (e) {}
    }
    initSubjectSwitch();
    render();
    window.addEventListener('hashchange', render);
    refreshMeta();
    staleShellGuard();
    startMetaPolling();
    /* 接口断开的瞬间收敛入口，恢复后自动放开；再顺带重拉一次 meta 把数字刷新 */
    if (window.API && St.subscribe) {
      St.subscribe('api:offline', function () { applyOfflineChrome(true); });
      St.subscribe('api:online', function () { applyOfflineChrome(false); refreshMeta(); });
    }
  }

  /* 标签实时更新：
     - 页面可见时每 60 秒比对一次版本号（没变化只有几十字节，几乎零成本）；
     - 切回标签页时如果距上次刷新超过 15 秒，立刻比对一次；
     - 视图里改动了题库（交卷、审核等）可以调 window.MV_REFRESH_META() 手动触发。 */
  function startMetaPolling() {
    window.MV_REFRESH_META = function (force) {
      if (force) metaVer = '';
      return refreshMeta();
    };
    setInterval(function () {
      if (!document.hidden) refreshMeta();
    }, 60000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && Date.now() - lastMetaAt > 15000) refreshMeta();
    });
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

  /* PWA：只在 https 或 localhost 注册。失败不影响使用（file:// 与内网 http 都会抛）。
     注册地址带版本号：发版后 sw.js?v= 变了，浏览器立刻按「新脚本」处理（skipWaiting +
     clients.claim），旧缓存随之清掉；否则用户可能几天都还停在旧外壳上。 */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js' + (BUILD ? '?v=' + BUILD : '')).catch(function (e) {
        console.warn('[pwa] Service Worker 注册失败（不影响使用）', e && e.message);
      });
    });
    /* 新 SW 接管后自动刷一次页面。GitHub Pages 的 HTML 有分钟级 HTTP 缓存，
       不做这一步，用户不硬刷就会一直看到旧页面（「顶栏没有物理入口」多由此而来）。
       只刷一次：60 秒内重复触发直接跳过，首次安装（原本没有 controller）也不刷，避免循环刷新。 */
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController) return;
      let last = 0;
      try { last = Number(sessionStorage.getItem('mv_sw_reload_at') || 0); } catch (e) {}
      if (Date.now() - last < 60000) return;
      try { sessionStorage.setItem('mv_sw_reload_at', String(Date.now())); } catch (e) {}
      location.reload();
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
