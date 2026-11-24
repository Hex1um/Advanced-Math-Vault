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

  /* 一次性组卷：按题型抽题后写进本地区列表，再走原来的排卷流程 */
  function bindGen(el) {
    const btn = el.querySelector('#genPaper');
    if (!btn) return;
    btn.addEventListener('click', async function () {
      const hint = el.querySelector('#genHint');
      btn.disabled = true;
      hint.textContent = '正在抽题…';
      try {
        const r = await window.API.post('/api/paper/generate', {
          choice: Number(el.querySelector('#genChoice').value || 0),
          fill: Number(el.querySelector('#genFill').value || 0),
          solution: Number(el.querySelector('#genSolution').value || 0)
        });
        const codes = [];
        r.parts.forEach(function (part) { part.items.forEach(function (it) { codes.push(it.code); }); });
        if (!codes.length) { hint.textContent = '没抽到题，试试放宽条件'; return; }
        save({ items: codes, title: '2026 年全国硕士研究生招生考试', points: {} });
        hint.textContent = '已抽到 ' + codes.length + ' 题';
        Views.paper(el);
      } catch (e) {
        hint.textContent = e.message;
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* 试卷页 */
  Views.paper = function (el) {
    const p = load();

    /* 一键组卷面板：按考研数学一的题型结构随机抽题 */
    const genPanel =
      '<div class="card form-card" style="margin-bottom:18px">'
      + '<h3 style="margin:0 0 6px;font-size:15px">一键组卷（按考研题型结构随机抽题）</h3>'
      + '<p class="small muted" style="margin:0 0 12px">默认按数学一的 10 选择 + 6 填空 + 6 解答抽题；优先用题库里的考研真题，不够再用其它题补足。</p>'
      + '<div class="field-row three">'
      + '<div class="field"><label>选择题</label><input id="genChoice" type="number" min="0" max="20" value="10" /></div>'
      + '<div class="field"><label>填空题</label><input id="genFill" type="number" min="0" max="20" value="6" /></div>'
      + '<div class="field"><label>解答题</label><input id="genSolution" type="number" min="0" max="20" value="6" /></div>'
      + '</div>'
      + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
      + '<button class="btn btn-primary" id="genPaper">生成试卷</button>'
      + '<span class="small muted" id="genHint"></span></div>'
      + '</div>';

    if (!p.items.length) {
      el.innerHTML = '<div class="page-head"><div><h1>组卷</h1>'
        + '<p class="sub">一键随机组卷，或者在题库点题目右侧的「+」自己挑。</p></div></div>'
        + genPanel
        + '<div class="empty"><b>还没有选题</b><a href="#/problems">去题库挑题</a></div>';
      bindGen(el);
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
      + genPanel
      + '<div class="card paper-sheet" id="paperSheet"><div class="loading-row"><span class="spinner"></span>正在排卷…</div></div>';
    bindGen(el);

    window.API.get('/api/problems?c=' + encodeURIComponent(p.items.join(',')) + '&size=100')
      .then(function (d) { render(d.items || []); })
      .catch(function () {
        // 接口不支持 c= 时退化为逐个取
        Promise.all(p.items.map(function (c) { return window.API.get('/api/problems/' + c).then(function (r) { return r.problem; }).catch(function () { return null; }); }))
          .then(function (list) { render(list.filter(Boolean)); });
      });

    let showAns = false;

    /* 题型判定：优先看标题（考研真题标题带「选择题/填空题/解答题」），再看题干有没有 ABCD 选项 */
    function kindOf(p) {
      const t = p.title || '';
      if (/选择题/.test(t)) return 'choice';
      if (/填空题/.test(t)) return 'fill';
      if (/解答题|证明题|计算题/.test(t)) return 'solution';
      if (/[（(]\s*[A-D]\s*[)）]|^[A-D][.．、]/m.test(p.statement || '')) return 'choice';
      return 'solution';
    }

    /* 分值：选择题、填空各 5 分；解答题共 70 分，均分后余数给前面几题 */
    function assignPoints(list) {
      const choice = list.filter(function (p) { return kindOf(p) === 'choice'; });
      const fill = list.filter(function (p) { return kindOf(p) === 'fill'; });
      const sol = list.filter(function (p) { return kindOf(p) === 'solution'; });
      const map = {};
      choice.forEach(function (p) { map[p.code] = 5; });
      fill.forEach(function (p) { map[p.code] = 5; });
      if (sol.length) {
        // 贴近真题：第一道稍轻，其余等分（数学一 6 道解答是 10+12×5=70）
        const w = sol.map(function (_, i) { return i === 0 ? 0.85 : 1; });
        const unit = 70 / w.reduce(function (a, b) { return a + b; }, 0);
        const vals = w.map(function (x) { return Math.round(x * unit); });
        let diff = 70 - vals.reduce(function (a, b) { return a + b; }, 0);
        let idx = 0;
        while (diff !== 0) { vals[idx % vals.length] += diff > 0 ? 1 : -1; diff += diff > 0 ? -1 : 1; idx++; }
        sol.forEach(function (p, i) { map[p.code] = vals[i]; });
      }
      return { choice: choice, fill: fill, solution: sol, map: map };
    }

    function render(list) {
      const sheet = document.getElementById('paperSheet');
      if (!list.length) { sheet.innerHTML = '<div class="empty"><b>选题已失效</b>可能是题目被下架了，重新挑一次。</div>'; return; }

      // 保持抽取顺序：先选择题，再填空，最后解答
      const order = { choice: 0, fill: 1, solution: 2 };
      const sorted = list.slice().sort(function (a, b) { return order[kindOf(a)] - order[kindOf(b)]; });
      const g = assignPoints(sorted);
      const total = sorted.reduce(function (s, p) { return s + (g.map[p.code] || 5); }, 0);

      let no = 0;
      const CN = ['一', '二', '三', '四'];
      let secIdx = 0;
      function section(label, rule, items, withBlank) {
        if (!items.length) return '';
        const from = no + 1;
        const to = no + items.length;
        const numbered = CN[secIdx++] + '、' + label;
        const rows = items.map(function (p) {
          no++;
          const pts = g.map[p.code] || 5;
          const blankH = withBlank ? Math.max(150, Math.min(300, 60 + pts * 13)) : 0;
          return '<div class="exam-q">'
            + '<div class="exam-q-body">'
            + '<span class="exam-q-no">' + no + '.</span>'
            + (withBlank ? '<span class="exam-q-points">（本题满分 ' + pts + ' 分）</span>' : '')
            + '<span class="exam-q-text">' + window.Md.toHtml(p.statement) + '</span>'
            + '</div>'
            + (withBlank ? '<div class="exam-blank" style="height:' + blankH + 'px"></div>' : '<div class="exam-gap"></div>')
            + '<div class="pq-answer" style="display:none"><b>答案</b>'
            + (p.answer ? window.Md.toHtml(p.answer) : '<span class="muted">（暂无答案）</span>')
            + (p.solution ? '<div class="ans-sol">' + window.Md.toHtml(p.solution) + '</div>' : '')
            + '</div>'
            + '</div>';
        }).join('');
        return '<div class="exam-section">'
          + '<div class="exam-sec-title">' + numbered + '：' + from + '～' + to + ' 小题，' + rule + '</div>'
          + rows + '</div>';
      }

      sheet.innerHTML =
        '<div class="exam-head">'
        + '<div class="exam-title">' + window.Md.esc(p.title || '全国硕士研究生招生考试') + '</div>'
        + '<div class="exam-sub">' + (/全国硕士|考研|数学一/.test(p.title || '') ? '数学（一）模拟试卷' : '模拟试卷') + '</div>'
        + '<div class="exam-note">（满分 ' + total + ' 分　考试时间 180 分钟）</div>'
        + '</div>'
        + '<div class="exam-tips"><b>考生注意事项</b>'
        + '<ol>'
        + '<li>答题前，考生须在试卷指定位置填写姓名、考生编号。</li>'
        + '<li>选择题和填空题只写答案，解答题须写出文字说明、证明过程或演算步骤。</li>'
        + '<li>试卷共 ' + [g.choice, g.fill, g.solution].filter(function (x) { return x.length; }).length + ' 大题，满分 ' + total + ' 分，考试时间 180 分钟。</li>'
        + '</ol></div>'
        + '<div class="exam-meta"><span>姓名 ____________</span><span>考生编号 ____________</span><span>得分 ____________</span></div>'
        + section('选择题', '每小题 5 分，共 ' + g.choice.length * 5 + ' 分。下列每题给出的四个选项中，只有一个选项符合题目要求。', g.choice, false)
        + section('填空题', '每小题 5 分，共 ' + g.fill.length * 5 + ' 分。', g.fill, false)
        + section('解答题', '共 70 分。解答应写出文字说明、证明过程或演算步骤。', g.solution, true)
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
