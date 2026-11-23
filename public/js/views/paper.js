/* 组卷：从题库选题 → 生成试卷（可打印）→ 答案页 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};
  const KEY = 'mv_paper_v1';

  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || 'null');
      return v && Array.isArray(v.items) ? v : { items: [], title: '高等数学练习卷', points: {} };
    } catch (e) { return { items: [], title: '高等数学练习卷', points: {} }; }
  }

  function save(p) {
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) {}
    window.dispatchEvent(new Event('paper:change'));
  }

  function has(code) {
    return load().items.indexOf(code) >= 0;
  }

  function toggle(code) {
    const p = load();
    const i = p.items.indexOf(code);
    if (i >= 0) p.items.splice(i, 1);
    else p.items.push(code);
    save(p);
    return i < 0;
  }

  function clear() {
    save({ items: [], title: '高等数学练习卷', points: {} });
  }

  window.Paper = { load: load, save: save, has: has, toggle: toggle, clear: clear };

  /* 底部悬浮条 */
  function mountBar() {
    let bar = document.getElementById('paperBar');
    const p = load();
    if (!p.items.length) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'paperBar';
      bar.className = 'paper-bar';
      document.body.appendChild(bar);
    }
    bar.innerHTML = '<span>已选 <b>' + p.items.length + '</b> 题</span>'
      + '<a class="btn btn-sm btn-primary" href="#/paper">去组卷</a>'
      + '<button class="btn btn-sm" id="paperClear">清空</button>';
    bar.querySelector('#paperClear').addEventListener('click', function () {
      clear();
      mountBar();
      if (window.API.State.route && window.API.State.route.name === 'paper') window.Views.paper(document.getElementById('view'));
    });
  }

  window.addEventListener('paper:change', mountBar);
  document.addEventListener('DOMContentLoaded', mountBar);

  /* 试卷页 */
  Views.paper = function (el) {
    const p = load();
    if (!p.items.length) {
      el.innerHTML = '<div class="page-head"><div><h1>组卷</h1>'
        + '<p class="sub">在题库点题目右侧的「+」，选够题就能在这里生成试卷。</p></div></div>'
        + '<div class="empty"><b>还没有选题</b><a href="#/problems">去题库挑题</a></div>';
      mountBar();
      return;
    }

    el.innerHTML = '<div class="page-head"><div><h1>组卷</h1>'
      + '<p class="sub">共 ' + p.items.length + ' 题。可以直接打印（Ctrl/⌘+P），也可以切换答案页给学生对答案。</p></div>'
      + '<div class="head-actions">'
      + '<button class="btn" id="toggleAns">显示答案</button>'
      + '<button class="btn btn-primary" id="printPaper">打印试卷</button>'
      + '<button class="btn" id="clearPaper">清空</button>'
      + '</div></div>'
      + '<div class="card paper-sheet" id="paperSheet"><div class="loading-row"><span class="spinner"></span>正在排卷…</div></div>';

    window.API.get('/api/problems?c=' + encodeURIComponent(p.items.join(',')) + '&size=100')
      .then(function (d) { render(d.items || []); })
      .catch(function () {
        // 接口不支持 c= 时退化为逐个取
        Promise.all(p.items.map(function (c) { return window.API.get('/api/problems/' + c).then(function (r) { return r.problem; }).catch(function () { return null; }); }))
          .then(function (list) { render(list.filter(Boolean)); });
      });

    let showAns = false;

    function render(list) {
      const sheet = document.getElementById('paperSheet');
      if (!list.length) { sheet.innerHTML = '<div class="empty"><b>选题已失效</b>可能是题目被下架了，重新挑一次。</div>'; return; }
      sheet.innerHTML =
        '<div class="paper-head"><h2>' + window.Md.esc(p.title || '高等数学练习卷') + '</h2>'
        + '<div class="paper-meta">共 ' + list.length + ' 题 · 姓名 __________ 学号 __________ 得分 ______</div></div>'
        + list.map(function (p, i) {
          return '<div class="paper-q">'
            + '<div class="pq-head"><span class="pq-no">' + (i + 1) + '.</span>'
            + '<span class="tag">' + p.tags.slice(0, 2).map(function (t) { return window.Md.esc(t); }).join(' / ') + '</span>'
            + '<span class="pq-points">（' + (p.difficulty >= 8 ? 12 : p.difficulty >= 6 ? 10 : 8) + ' 分）</span></div>'
            + '<div class="pq-body">' + window.Md.toHtml(p.statement) + '</div>'
            + '<div class="pq-blank"></div>'
            + '<div class="pq-answer" style="display:none"><b>答案</b>'
            + (p.answer ? window.Md.toHtml(p.answer) : '<span class="muted">（做过的题才显示答案，避免提前剧透）</span>')
            + '</div>'
            + '</div>';
        }).join('')
        + '<div class="paper-foot">— 试卷结束 —</div>';
      window.Md.renderMath(sheet);
    }

    el.querySelector('#toggleAns').addEventListener('click', function () {
      showAns = !showAns;
      el.querySelectorAll('.pq-answer').forEach(function (x) { x.style.display = showAns ? 'block' : 'none'; });
      this.textContent = showAns ? '隐藏答案' : '显示答案';
    });

    el.querySelector('#printPaper').addEventListener('click', function () { window.print(); });

    el.querySelector('#clearPaper').addEventListener('click', function () {
      clear();
      Views.paper(el);
    });

    mountBar();
  };
})();
