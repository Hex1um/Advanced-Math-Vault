/* 题库列表 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};
  const St = window.API.State;

  let filters = { q: '', tags: [], level: '', status: 'all', sort: 'code', page: 1, tagsExpanded: false };
  let cache = null;

  function titleHTML(t) {
    // 列表里把展示型分式收成行内分式，避免行高被撑开
    return window.Md.inlineTex(String(t || '').replace(/\\dfrac/g, '\\frac').replace(/\\displaystyle/g, ''));
  }

  function buildQuery() {
    const p = new URLSearchParams();
    if (filters.q) p.set('q', filters.q);
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
      + '<div class="stat"><div class="k">考点标签</div><div class="v">' + (s.tags || 0) + '<small>个</small></div></div>'
      + '<div class="stat"><div class="k">全站做题</div><div class="v">' + (s.solves || 0) + '<small>次</small></div></div>'
      + '<div class="stat"><div class="k">我的进度</div><div class="v">' + (me ? me.solvedCount : 0) + '<small>' + (me ? '题' : '登录后记录') + '</small></div></div>';
  }

  async function startPractice(mode) {
    if (!window.UI.requireLogin(null, '登录后才能刷题（要记录进度）')) return;
    const q = new URLSearchParams({ mode: mode });
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

  function renderFilters(tags) {
    const d = document.getElementById('filterBox');
    if (!d) return;

    const levelChips = ['<button class="chip' + (!filters.level ? ' active' : '') + '" data-level="">全部难度</button>']
      .concat(window.UI.LEVELS.map(function (l) {
        return '<button class="chip' + (filters.level === l.name ? ' active' : '') + '" data-level="' + window.Md.esc(l.name) + '">'
          + '<span style="width:6px;height:6px;border-radius:50%;background:' + l.color + '"></span>' + l.name + '</button>';
      })).join('');

    const shownTags = filters.tagsExpanded ? tags : tags.slice(0, 10);
    const tagChips = ['<button class="chip' + (!filters.tags.length ? ' active' : '') + '" data-tag="">不限考点</button>']
      .concat(shownTags.map(function (t) {
        const on = filters.tags.indexOf(t.name) >= 0;
        return '<button class="chip' + (on ? ' active' : '') + '" data-tag="' + window.Md.esc(t.name) + '">'
          + window.Md.esc(t.name) + '<span class="n">' + t.count + '</span></button>';
      }))
      .concat(tags.length > 10
        ? ['<button class="chip" data-more="1">' + (filters.tagsExpanded ? '收起考点' : '更多考点 +' + (tags.length - 10)) + '</button>']
        : [])
      .join('');

    d.innerHTML =
      '<div class="filter-row"><span class="filter-label">难度</span><div class="chip-scroll">' + levelChips + '</div></div>'
      + '<div class="filter-row"><span class="filter-label">考点</span><div class="chip-scroll">' + tagChips + '</div></div>'
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
        renderFilters(St.tags || []);
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

    const rows = data.items.map(function (p) {
      const lv = window.UI.levelOf(p.difficulty);
      const rate = p.attemptCount ? Math.round((p.solvedCount / Math.max(1, p.attemptCount + p.solvedCount)) * 100) + '%' : '—';
      return '<div class="prow' + (p.solved ? ' solved' : '') + '" data-code="' + p.code + '">'
        + '<div class="pstate">' + (p.solved ? '<span class="ok">✓</span>' : '<span class="none"></span>') + '</div>'
        + '<div class="pcode">' + p.code + '</div>'
        + '<div class="pmain">'
        + '<div class="pexcerpt"><a href="#/problem/' + p.code + '">' + titleHTML(p.excerpt || p.title) + '</a></div>'
        + '<div class="tags">' + p.tags.map(function (t) { return '<span class="tag">' + window.Md.esc(t) + '</span>'; }).join('') + '</div>'
        + window.UI.scoreBars(p, true)
        + '</div>'
        + '<div class="pdiff">' + window.UI.levelBadge(p) + '<span class="rate">通过率 ' + rate + '</span></div>'
        + '<div class="pmeta"><button class="paper-add" data-code="' + p.code + '" title="加入试卷">' + (window.Paper && window.Paper.has(p.code) ? '✓' : '+') + '</button>'
        + '<span>' + p.solvedCount + ' 通过</span></div>'
        + '</div>';
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
    try {
      const data = await window.API.get('/api/problems?' + buildQuery());
      St.tags = data.tags;
      renderFilters(data.tags);
      renderList(data);
      renderStats();
      bindPaperAdd(document.getElementById('listWrap'));
    } catch (e) {
      if (wrap) wrap.innerHTML = window.UI.empty('加载失败', e.message);
    }
  }

  Views.library = function (el, params) {
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

    load();
  };

  Views.library.reset = function () {
    filters = { q: '', tags: [], level: '', status: 'all', sort: 'code', page: 1 };
  };
})();
