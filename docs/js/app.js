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
    if (seg[0] === 'submit') return { name: 'submit', params: params, nav: 'submit' };
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
    document.title = (window.MV_CONFIG && window.MV_CONFIG.siteName) || 'Advanced-Math-Vault';

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
    el.textContent = '收录 ' + (s.problems || 0) + ' 题 · ' + (s.users || 0) + ' 位同学 · ' + (s.tags || 0) + ' 个考点';
  }

  async function refreshMeta() {
    try {
      const meta = await window.API.get('/api/meta');
      St.me = meta.me;
      St.stats = meta.stats;
      St.llm = meta.llm;
      window.UI.renderHeader();
      updateFooter();
    } catch (e) {
      console.error('[app] meta 加载失败', e);
    }
  }

  async function boot() {
    await refreshMeta();
    render();
    window.addEventListener('hashchange', render);
  }

  window.App = {
    refresh: async function () {
      await refreshMeta();
      render();
    },
    render: render,
    route: () => St.route
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
