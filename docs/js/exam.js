/* 计时模考：倒计时 + 自动保存 + 交卷判分（客观题自动、解答题待自评）
   数据全部放 localStorage，刷新页面不丢答案；判分只在交卷时打一次 /api/exam/grade。 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};
  const KEY = 'mv_exam_v1';

  function read() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!v || !Array.isArray(v.items) || !v.items.length) return null;
      if (!v.answers || typeof v.answers !== 'object') v.answers = {};
      return v;
    } catch (e) { return null; }
  }

  function write(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (e) {}
  }

  function mmss(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    return (h ? h + ':' : '') + pad(m) + ':' + pad(s);
  }

  function start(spec) {
    const items = [];
    (spec.parts || []).forEach(function (part) {
      (part.items || []).forEach(function (it) {
        items.push({
          code: it.code,
          title: it.title || '',
          statement: it.statement || '',
          points: it.points || 5,
          kind: part.kind,
          seconds: it.seconds || 0
        });
      });
    });
    if (!items.length) return false;
    const now = Date.now();
    write({
      id: 'exam-' + now.toString(36),
      title: spec.title || '高等数学模考',
      minutes: Number(spec.minutes) || 60,
      startedAt: now,
      endsAt: now + (Number(spec.minutes) || 60) * 60000,
      items: items,
      answers: {},
      submitted: false,
      result: null
    });
    return true;
  }

  function answeredCount(state) {
    return state.items.filter(function (it) { return String(state.answers[it.code] || '').trim(); }).length;
  }

  function statusLabel(it, res) {
    if (!res) return '';
    const map = {
      correct: ['tag gold', '正确'],
      wrong: ['tag', '错误'],
      blank: ['tag', '未作答'],
      manual: ['tag', '待自评'],
      missing: ['tag', '题目已下架']
    };
    const x = map[res.status] || map.blank;
    return '<span class="' + x[0] + '">' + x[1] + (res.score ? ' +' + res.score : '') + '</span>';
  }

  Views.exam = function (el) {
    let state = read();
    if (!state) {
      el.innerHTML = '<div class="page-head"><div><h1>计时模考</h1>'
        + '<p class="sub">还没有进行中的模考。去组卷页用「智能组卷」生成一份，或直接开始。</p></div></div>'
        + '<div class="empty"><b>没有试卷</b><a href="#/paper">去组卷</a></div>';
      return;
    }

    let timer = null;
    let saveTimer = null;
    let disposed = false;

    function persist() {
      if (disposed) return;
      write(state);
    }

    function schedulePersist() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 350);
    }

    function remaining() {
      return state.endsAt - Date.now();
    }

    function render() {
      if (disposed) return;
      const done = answeredCount(state);
      const total = state.items.length;
      const resMap = {};
      if (state.result && state.result.items) {
        state.result.items.forEach(function (r) { resMap[r.code] = r; });
      }
      const submitted = !!state.submitted;

      el.innerHTML = '<div class="page-head"><div><h1>' + window.Md.esc(state.title) + '</h1>'
        + '<p class="sub">共 ' + total + ' 题 · ' + state.minutes + ' 分钟 · '
        + (submitted ? '已交卷' : '答案自动保存在本机，刷新不丢') + '</p></div>'
        + '<div class="head-actions">'
        + (submitted ? '<a class="btn" href="#/paper">回组卷</a><button class="btn" id="examRestart">再考一次</button>'
          : '<button class="btn" id="examSubmit">交卷</button>')
        + '</div></div>'
        + (submitted && state.result
          ? '<div class="card exam-result"><div class="exam-score">' + state.result.score
            + '<small> / ' + state.result.total + ' 分</small></div>'
            + '<div class="small muted">客观题得分率 ' + state.result.percent + '%；解答题需要在原题页自评。</div></div>'
          : '<div class="exam-bar"><span class="exam-timer" id="examTimer">' + mmss(remaining()) + '</span>'
            + '<span class="small muted">已答 ' + done + ' / ' + total + '</span>'
            + '<div class="exam-progress"><i style="width:' + Math.round((done / Math.max(1, total)) * 100) + '%"></i></div>'
            + '<span class="small muted" id="examHint"></span></div>')
        + '<div class="exam-list">'
        + state.items.map(function (it, i) {
          const ans = state.answers[it.code] || '';
          const res = resMap[it.code];
          return '<div class="exam-item' + (submitted ? ' locked' : '') + '" data-code="' + it.code + '">'
            + '<div class="exam-q-head">'
            + '<b>' + (i + 1) + '.</b>'
            + '<span class="small muted">' + it.points + ' 分</span>'
            + '<span class="small muted">' + window.Md.esc(it.code) + '</span>'
            + statusLabel(it, res)
            + '<a class="small" href="#/problem/' + it.code + '" style="margin-left:auto">打开原题</a>'
            + '</div>'
            + '<div class="exam-q-body md" data-statement="' + it.code + '"></div>'
            + (submitted
              ? '<div class="exam-answer static">' + (ans ? window.Md.esc(ans) : '<span class="muted">未作答</span>') + '</div>'
              : (it.kind === 'solution'
                ? '<textarea class="control exam-input" data-input="' + it.code + '" rows="4" placeholder="写下关键步骤（解答题交卷后回原题判卷）">' + window.Md.esc(ans) + '</textarea>'
                : '<input class="control exam-input" data-input="' + it.code + '" placeholder="填答案，交卷自动判分" value="' + window.Md.esc(ans) + '" />'))
            + '</div>';
        }).join('')
        + '</div>';

      // 题干用统一的 markdown/公式渲染
      state.items.forEach(function (it) {
        const box = el.querySelector('[data-statement="' + it.code + '"]');
        if (box) window.Md.render(box, it.statement);
      });

      el.querySelectorAll('[data-input]').forEach(function (input) {
        input.addEventListener('input', function () {
          state.answers[input.getAttribute('data-input')] = input.value;
          schedulePersist();
          const bar = document.getElementById('examHint');
          if (bar) bar.textContent = '已保存';
          setTimeout(function () {
            const b = document.getElementById('examHint');
            if (b && b.textContent === '已保存') b.textContent = '';
            const cnt = document.querySelector('.exam-bar .small.muted');
            if (cnt) cnt.textContent = '已答 ' + answeredCount(state) + ' / ' + state.items.length;
            const fill = document.querySelector('.exam-progress i');
            if (fill) fill.style.width = Math.round((answeredCount(state) / Math.max(1, state.items.length)) * 100) + '%';
          }, 1200);
        });
      });

      const submitBtn = document.getElementById('examSubmit');
      if (submitBtn) submitBtn.addEventListener('click', function () { submit(false); });
      const restart = document.getElementById('examRestart');
      if (restart) restart.addEventListener('click', function () {
        const again = { title: state.title, minutes: state.minutes, parts: [{ kind: 'mix', items: state.items }] };
        clear();
        if (start(again)) { state = read(); render(); }
      });

      tick();
    }

    function tick() {
      if (disposed || state.submitted) return;
      const left = remaining();
      const box = document.getElementById('examTimer');
      if (box) {
        box.textContent = mmss(left);
        box.classList.toggle('urgent', left <= 5 * 60000);
      }
      if (left <= 0) {
        submit(true);
      }
    }

    async function submit(auto) {
      if (state.submitted) return;
      const done = answeredCount(state);
      if (!auto && done < state.items.length) {
        const ok = window.confirm('还有 ' + (state.items.length - done) + ' 题没作答，确定交卷？');
        if (!ok) return;
      }
      const btn = document.getElementById('examSubmit');
      if (btn) { btn.disabled = true; btn.textContent = '判卷中…'; }
      try {
        const payload = state.items.map(function (it) {
          return { code: it.code, answer: state.answers[it.code] || '' };
        });
        const r = await window.API.post('/api/exam/grade', { items: payload });
        state.submitted = true;
        state.result = { score: r.score, total: r.total, percent: r.percent, items: r.items, at: Date.now() };
        persist();
        if (auto) window.UI.toast('时间到，已自动交卷', 'ok');
        render();
      } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = '交卷'; }
        window.UI.toast(window.API.describe ? window.API.describe(e) : e.message, 'err');
      }
    }

    render();
    timer = setInterval(tick, 1000);

    return function cleanup() {
      disposed = true;
      if (timer) clearInterval(timer);
      if (saveTimer) clearTimeout(saveTimer);
      persist();
    };
  };

  window.Exam = { start: start, read: read, clear: clear, mmss: mmss };
})();
