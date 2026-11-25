/* 题库列表 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};
  const St = window.API.State;

  let filters = { q: '', mainTag: '', examTag: '', tags: [], level: '', status: 'all', sort: 'code', page: 1, tagsExpanded: false };
  let cache = null;

  /* 防竞态：快速连点筛选会并发出多个请求，先发的后到就会把列表刷成旧结果。
     每次 load 都 abort 上一个请求并用单调递增的 reqSeq 丢弃过期响应。 */
  let activeCtrl = null;
  let reqSeq = 0;
  let unsubMeta = null;

  function titleHTML(t) {
    // 列表里把展示型分式收成行内分式，避免行高被撑开
    return window.Md.inlineTex(String(t || '').replace(/\\dfrac/g, '\\frac').replace(/\\displaystyle/g, ''));
  }

  function buildQuery() {
    const p = new URLSearchParams();
    if (filters.q) p.set('q', filters.q);
    if (filters.mainTag) p.set('main', filters.mainTag);
    if (filters.examTag) p.set('exam', filters.examTag);
    if (filters.tags.length) p.set('tags', filters.tags.join(','));
    if (filters.level) p.set('level', filters.level);
    if (filters.status !== 'all') p.set('status', filters.status);
    if (filters.sort !== 'code') p.set('sort', filters.sort);
    p.set('page', String(filters.page));
    p.set('size', '20');
    return p.toString();
  }

  function renderStats() {
    const s = St.stats || {};
    const me = St.me;
    const wrap = document.getElementById('statStrip');
    if (!wrap) return;
    wrap.innerHTML =
      '<div class="stat"><div class="k">收录题目</div><div class="v">' + (s.problems || 0) + '<small>题</small></div></div>'
      + '<div class="stat"><div class="k">主标签</div><div class="v">' + (s.mainTags || 0) + '<small>个</small></div></div>'
      + '<div class="stat"><div class="k">全站做题</div><div class="v">' + (s.solves || 0) + '<small>次</small></div></div>'
      + '<div class="stat"><div class="k">我的进度</div><div class="v">' + (me ? me.solvedCount : 0) + '<small>' + (me ? '题' : '登录后记录') + '</small></div></div>';
  }

  async function startPractice(mode) {
    if (!window.UI.requireLogin(null, '登录后才能刷题（要记录进度）')) return;
    const q = new URLSearchParams({ mode: mode });
    if (filters.mainTag) q.set('main', filters.mainTag);
    if (filters.examTag) q.set('exam', filters.examTag);
    if (filters.tags.length) q.set('tags', filters.tags.join(','));
    if (filters.level) {
      const map = { easy: [1, 3], medium: [4, 6], hard: [7, 10], expert: [11, 15] };
      const r = map[filters.level];
      if (r) { q.set('dmin', r[0]); q.set('dmax', r[1]); }
    }
    try {
      const d = await window.API.get('/api/practice?' + q.toString());
      if (!d.code) { window.UI.toast('这个范围里的题都做完了', 'ok'); return; }
      location.hash = '#/problem/' + d.code;
    } catch (e) {
      window.UI.toast(e.message, 'err');
    }
  }

  function renderFilters() {
    const d = document.getElementById('filterBox');
    if (!d) return;

    const tree = St.tagTree || [];
    const flat = St.tags || [];
    const levelChips = ['<button class="chip' + (!filters.level ? ' active' : '') + '" data-level="">全部难度</button>']
      .concat(window.UI.LEVELS.map(function (l) {
        return '<button class="chip' + (filters.level === l.name ? ' active' : '') + '" data-level="' + window.Md.esc(l.name) + '">'
          + '<span style="width:6px;height:6px;border-radius:50%;background:' + l.color + '"></span>' + l.name + '</button>';
      })).join('');

    const activeMain = tree.filter(function (m) { return m.name === filters.mainTag; })[0] || null;
    const mainChips = ['<button class="chip' + (!filters.mainTag ? ' active' : '') + '" data-main="">全部主标签</button>']
      .concat(tree.map(function (m) {
        return '<button class="chip' + (filters.mainTag === m.name ? ' active' : '') + '" data-main="' + window.Md.esc(m.name) + '">'
          + window.Md.esc(m.name) + '<span class="n">' + m.count + '</span></button>';
      })).join('');

    const pool = activeMain ? activeMain.children : flat;
    const shownTags = filters.tagsExpanded ? pool : pool.slice(0, 12);
    const tagChips = ['<button class="chip' + (!filters.tags.length ? ' active' : '') + '" data-tag="">不限子标签</button>']
      .concat(shownTags.map(function (t) {
        const on = filters.tags.indexOf(t.name) >= 0;
        return '<button class="chip' + (on ? ' active' : '') + '" data-tag="' + window.Md.esc(t.name) + '">'
          + window.Md.esc(t.name) + '<span class="n">' + t.count + '</span></button>';
      }))
      .concat(pool.length > 12
        ? ['<button class="chip" data-more="1">' + (filters.tagsExpanded ? '收起子标签' : '更多子标签 +' + (pool.length - 12)) + '</button>']
        : [])
      .join('');

    const examTags = St.examTags || [];
    const examChips = examTags.length
      ? '<div class="filter-row"><span class="filter-label">来源</span><div class="chip-scroll">'
        + '<button class="chip' + (!filters.examTag ? ' active' : '') + '" data-exam="">全部来源</button>'
        + examTags.map(function (x) {
          return '<button class="chip' + (filters.examTag === x.name ? ' active' : '') + '" data-exam="' + window.Md.esc(x.name) + '">'
            + window.Md.esc(x.name) + '<span class="n">' + x.count + '</span></button>';
        }).join('') + '</div></div>'
      : '';

    d.innerHTML =
      '<div class="filter-row"><span class="filter-label">主标签</span><div class="chip-scroll">' + mainChips + '</div></div>'
      + '<div class="filter-row"><span class="filter-label">子标签</span><div class="chip-scroll">' + tagChips + '</div></div>'
      + examChips
      + '<div class="filter-row"><span class="filter-label">难度</span><div class="chip-scroll">' + levelChips + '</div></div>'
      + '<div class="filter-row" style="gap:10px">'
      + '<div class="search-box">' + window.UI.icon('search')
      + '<input id="qInput" placeholder="搜索题目 / 编号 / 考点" value="' + window.Md.esc(filters.q) + '" />'
      + '</div>'
      + '<select class="control" id="statusSel">'
      + '<option value="all"' + (filters.status === 'all' ? ' selected' : '') + '>全部状态</option>'
      + '<option value="unsolved"' + (filters.status === 'unsolved' ? ' selected' : '') + '>未做</option>'
      + '<option value="solved"' + (filters.status === 'solved' ? ' selected' : '') + '>已通过</option>'
      + '</select>'
      + '<select class="control" id="sortSel">'
      + '<option value="code"' + (filters.sort === 'code' ? ' selected' : '') + '>按编号</option>'
      + '<option value="difficulty"' + (filters.sort === 'difficulty' ? ' selected' : '') + '>按难度</option>'
      + '<option value="thinking"' + (filters.sort === 'thinking' ? ' selected' : '') + '>按思维量</option>'
      + '<option value="calc"' + (filters.sort === 'calc' ? ' selected' : '') + '>按计算量</option>'
      + '<option value="newest"' + (filters.sort === 'newest' ? ' selected' : '') + '>最新收录</option>'
      + '</select>'
      + '<span class="small muted right" id="countHint"></span>'
      + '</div>';

    d.querySelectorAll('[data-level]').forEach(function (b) {
      b.addEventListener('click', function () {
        filters.level = b.dataset.level;
        filters.page = 1;
        load();
      });
    });
    d.querySelectorAll('[data-main]').forEach(function (b) {
      b.addEventListener('click', function () {
        filters.mainTag = b.dataset.main;
        filters.tags = [];
        filters.tagsExpanded = false;
        filters.page = 1;
        load();
      });
    });
    d.querySelectorAll('[data-exam]').forEach(function (b) {
      b.addEventListener('click', function () {
        filters.examTag = b.dataset.exam;
        filters.page = 1;
        load();
      });
    });
    d.querySelectorAll('[data-tag]').forEach(function (b) {
      b.addEventListener('click', function () {
        const t = b.dataset.tag;
        if (!t) filters.tags = [];
        else {
          const i = filters.tags.indexOf(t);
          if (i >= 0) filters.tags.splice(i, 1);
          else filters.tags.push(t);
        }
        filters.page = 1;
        load();
      });
    });

    const more = d.querySelector('[data-more]');
    if (more) {
      more.addEventListener('click', function () {
        filters.tagsExpanded = !filters.tagsExpanded;
        renderFilters();
      });
    }

    const q = d.querySelector('#qInput');
    let timer = null;
    q.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        filters.q = q.value.trim();
        filters.page = 1;
        load();
      }, 260);
    });
    q.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { filters.q = q.value.trim(); filters.page = 1; load(); }
    });
    d.querySelector('#statusSel').addEventListener('change', function (e) { filters.status = e.target.value; filters.page = 1; load(); });
    d.querySelector('#sortSel').addEventListener('change', function (e) { filters.sort = e.target.value; filters.page = 1; load(); });
  }


  function bindPaperAdd(root) {
    if (!root || root.__paperBound) return;
    root.__paperBound = true;
    root.addEventListener('click', function (ev) {
      const btn = ev.target.closest && ev.target.closest('.paper-add');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (!window.Paper) return;
      const added = window.Paper.toggle(btn.dataset.code);
      btn.textContent = added ? '✓' : '+';
      window.UI.toast(added ? '已加入试卷' : '已从试卷移除');
    });
  }

  function renderList(data) {
    const wrap = document.getElementById('listWrap');
    const pagerWrap = document.getElementById('pagerWrap');
    if (!wrap) return;

    const hint = document.getElementById('countHint');
    if (hint) hint.textContent = '共 ' + data.total + ' 题';

    if (!data.items.length) {
      wrap.innerHTML = window.UI.empty('没有符合条件的题目', '换个筛选条件试试，或者去投稿一道好题。');
      if (pagerWrap) pagerWrap.innerHTML = '';
      return;
    }

    /* 行渲染交给 Components.problemRow：题库 / 错题本 / 组卷预览共用同一份结构，
       改一次三处生效（以前是三份手写 HTML，样式改了经常漏一处）。 */
    const rows = data.items.map(function (p) {
      // 列表里把展示型分式收成行内分式，避免行高被撑开（与 titleHTML 的处理一致）
      const slim = Object.assign({}, p, {
        excerpt: String(p.excerpt || p.title || '').replace(/\\dfrac/g, '\\frac').replace(/\\displaystyle/g, '')
      });
      return window.Components.problemRow(slim, {
        paperAdded: !!(window.Paper && window.Paper.has(p.code))
      });
    }).join('');

    wrap.innerHTML =
      '<div class="ptable">'
      + '<div class="ptable-head"><span>状态</span><span>编号</span><span>题目 / 考点 / 三维评分</span><span>难度</span><span>数据</span></div>'
      + rows + '</div>';

    wrap.querySelectorAll('.prow').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('a')) return;
        location.hash = '#/problem/' + row.dataset.code;
      });
    });

    if (pagerWrap) {
      pagerWrap.innerHTML = '';
      pagerWrap.appendChild(window.UI.pagination(data.page, data.pages, function (page) {
        filters.page = page;
        load();
        window.scrollTo({ top: 220, behavior: 'smooth' });
      }));
    }
  }

  async function load() {
    const wrap = document.getElementById('listWrap');
    if (wrap && !cache) wrap.innerHTML = '<div class="loading-row"><span class="spinner"></span>正在取题…</div>';

    if (activeCtrl) { try { activeCtrl.abort(); } catch (e) {} }
    const ctrl = new AbortController();
    activeCtrl = ctrl;
    const mySeq = ++reqSeq;

    try {
      const data = await window.API.get('/api/problems?' + buildQuery(), { signal: ctrl.signal });
      if (mySeq !== reqSeq) return;   // 已有更新的请求发出，这次结果作废
      cache = data;
      St.tagTree = data.tagTree || St.tagTree || [];
      St.examTags = data.examTags || St.examTags || [];
      St.tags = data.tags || [];
      renderFilters();
      renderList(data);
      renderStats();
      bindPaperAdd(document.getElementById('listWrap'));
    } catch (e) {
      if (mySeq !== reqSeq) return;
      if (e && e.kind === 'aborted') return;
      if (wrap) wrap.innerHTML = window.UI.empty('加载失败', window.API.describe ? window.API.describe(e) : e.message);
    } finally {
      if (activeCtrl === ctrl) activeCtrl = null;
    }
  }

  Views.library = function (el, params) {
    if (params && params.main) { filters.mainTag = params.main; }
    if (params && params.exam) { filters.examTag = params.exam; }
    if (params && params.tag) { filters.tags = [params.tag]; }
    if (params && params.q) { filters.q = params.q; }

    el.innerHTML =
      '<div class="page-head">'
      + '<div><h1>题库</h1>'
      + '<p class="sub">题库统一校对后入库，每题标注考点与思维量、难度、计算量三个维度，附带答案与关键思路。做不出来可以看答案，也可以直接问 AI。</p></div>'
      + '<div class="head-actions">'
      + '<button class="btn" id="seqBtn" title="按编号刷当前筛选里还没做过的题">顺序刷</button>'
      + '<button class="btn" id="randBtn" title="随机来一道还没做过的题">随机刷</button>'
      + '<a class="btn btn-primary" href="#/submit">' + window.UI.icon('plus') + ' 投稿</a>'
      + '</div>'
      + '</div>'
      + '<div class="stat-strip" id="statStrip"></div>'
      + '<div class="filters" id="filterBox"></div>'
      + '<div id="listWrap"></div>'
      + '<div id="pagerWrap"></div>';

    const seqBtn = document.getElementById('seqBtn');
    const randBtn = document.getElementById('randBtn');
    if (seqBtn) seqBtn.addEventListener('click', function () { startPractice('seq'); });
    if (randBtn) randBtn.addEventListener('click', function () { startPractice('random'); });

    /* meta 是并行加载的：到货后只重画统计条与筛选器，不重新拉列表 */
    if (unsubMeta) { unsubMeta(); unsubMeta = null; }
    unsubMeta = St.subscribe('meta:updated', function () {
      if (!document.getElementById('filterBox')) return;
      renderStats();
      if (!cache) renderFilters();
    });

    load();

    return function cleanup() {
      if (activeCtrl) { try { activeCtrl.abort(); } catch (e) {} activeCtrl = null; }
      if (unsubMeta) { unsubMeta(); unsubMeta = null; }
    };
  };

  Views.library.reset = function () {
    filters = { q: '', tags: [], level: '', status: 'all', sort: 'code', page: 1 };
  };
})();
