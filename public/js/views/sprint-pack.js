/* 期末突击 · 科目工作台
   两个模式：
     学习知识点：章节 → 考点 → 一句话结论 / 展开 / 关键词 / 易错点，配 AI 讲解与真题练习
     分析薄弱：按错题率、提问次数、看答案次数算薄弱度，并生成可执行方案 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};
  const St = window.API.State;
  const API = window.API;
  const UI = window.UI;
  const esc = window.Md.esc;

  const TYPE_LABEL = {
    single: '单选', judge: '判断', short: '简答', essay: '论述',
    material: '材料分析', fill: '填空', calc: '计算', proof: '证明',
    code: '程序题', reading: '阅读', cloze: '选词'
  };

  function stars(n) {
    const v = Math.max(1, Math.min(5, Number(n) || 3));
    return '★'.repeat(v) + '<i>' + '★'.repeat(5 - v) + '</i>';
  }

  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  /* 背单词：四六级包里的词库用「先猜后看」的卡片流，评价映射到错题本同一套 FSRS：
     不认识 → again，模糊 → hard，认识 → good。同一轮里评「不认识」的词会插回三张之后，
     评「模糊」的词放到本轮末尾再过一遍，各自最多重复两次，保证一轮能走完。 */
  const RATE_KEYS = { '1': 'again', '2': 'hard', '3': 'good' };

  Views.sprintPack = function (el, params) {
    const packId = params.id;
    const state = {
      pack: null,
      chapters: [],
      tab: params.tab === 'weak' || params.tab === 'vocab' ? params.tab : 'study',
      pointId: params.p || '',
      openChapter: '',
      loggedIn: false,
      point: null,
      mine: null,
      questions: [],
      aiText: '',
      aiMode: '',
      weak: null,
      plan: '',
      answered: {},
      busy: false,
      vocab: {
        mode: 'mix',
        queue: [],
        done: 0,
        stats: null,
        revealed: false,
        quick: false,
        counts: { again: 0, hard: 0, good: 0 },
        loading: false,
        finished: false,
        err: ''
      }
    };

    el.innerHTML = '<div class="sp-loading">正在加载科目…</div>';

    /* ------------------------------------------------------------ 骨架 */

    function shellHTML() {
      const p = state.pack;
      const exam = (p.exam && p.exam.sections) || [];
      return ''
        + '<section class="sp-head">'
        + '  <a class="sp-back" href="#/sprint">← 期末突击</a>'
        + '  <div class="sp-head-main">'
        + '    <h1>' + esc(p.subject) + '</h1>'
        + '    <div class="sp-head-meta">'
        + '      <span>' + esc(p.school) + '</span><span class="dot">·</span>'
        + '      <span>' + esc(p.year) + ' ' + esc(p.term || '') + '</span><span class="dot">·</span>'
        + '      <span>' + p.counts.points + ' 考点</span><span class="dot">·</span>'
        + '      <span>' + p.counts.questions + ' 题</span>'
        + (p.counts.past ? '<span class="dot">·</span><span class="sp-past">' + p.counts.past + ' 道真题</span>' : '')
        + (p.private ? '<span class="sp-priv">仅你可见</span>' : '')
        + '    </div>'
        + '  </div>'
        + '  <div class="sp-blueprint">'
        + exam.map(function (s) {
          return '<span class="sp-sec"><b>' + esc(s.name) + '</b> ' + s.count + '×' + s.per + ' = ' + s.points + '′</span>';
        }).join('')
        + '  </div>'
        + '</section>'
        + '<div class="sp-tabs">'
        + '  <button class="sp-tab' + (state.tab === 'study' ? ' active' : '') + '" data-tab="study">学习知识点</button>'
        + '  <button class="sp-tab' + (state.tab === 'weak' ? ' active' : '') + '" data-tab="weak">分析薄弱</button>'
        + (p.counts.vocab
          ? '  <button class="sp-tab' + (state.tab === 'vocab' ? ' active' : '') + '" data-tab="vocab">背单词</button>'
          : '')
        + '  <span class="sp-tabs-hint">' + (state.loggedIn && state.mine
          ? '已练 ' + (state.mine.attempts || 0) + ' 题 · 学过 ' + (state.mine.touchedPoints || 0) + ' 个考点'
          : '登录后记录答题与提问') + '</span>'
        + '</div>'
        + '<div class="sp-work">'
        + '  <aside class="sp-side" id="spChapters"></aside>'
        + '  <section class="sp-pane" id="spPane"></section>'
        + '</div>';
    }

    function renderChapters() {
      const box = document.getElementById('spChapters');
      if (!box) return;
      const progress = (state.weak && state.weak.items) || [];
      const weakMap = {};
      progress.forEach(function (it) { weakMap[it.pointId] = it; });
      box.innerHTML = state.chapters.map(function (ch) {
        const active = state.point && state.point.chapter === ch.id;
        /* 展开状态单独用一个字段控制：以前只有「当前章节」自动展开，
           别的章节标题没有点击处理，手机上点第二、三章完全没反应。 */
        const open = state.openChapter === ch.id;
        return ''
          + '<div class="sp-chapter' + (active ? ' active' : '') + (open ? ' open' : '') + '">'
          + '  <button class="sp-ch-title" data-chapter="' + esc(ch.id) + '" aria-expanded="' + (open ? 'true' : 'false') + '">'
          + '    <span>' + esc(ch.no ? ch.no + ' ' : '') + esc(ch.title) + '</span>'
          + '    <em>' + ch.points.length + '</em>'
          + '    <i class="sp-caret" aria-hidden="true"></i>'
          + '  </button>'
          + '  <div class="sp-ch-points">'
          + ch.points.map(function (pt) {
            const w = weakMap[pt.id];
            const cls = 'sp-ch-point' + (state.pointId === pt.id ? ' active' : '')
              + (w && w.level === 'weak' ? ' weak' : '');
            return '<button class="' + cls + '" data-point="' + esc(pt.id) + '">'
              + '<span class="sp-dot"></span>' + esc(pt.title)
              + (pt.questions ? '<i>' + pt.questions + '</i>' : '')
              + '</button>';
          }).join('')
          + '  </div>'
          + '</div>';
      }).join('');
    }

    /* ------------------------------------------------------------ 学习：考点详情 */

    function paneStudyHTML() {
      const p = state.point;
      if (!p) return '<div class="empty">左边选一个考点开始</div>';
      const mine = state.mine && state.mine.point ? state.mine.point : null;
      const answeredCount = mine ? mine.attempts : 0;
      return ''
        + '<article class="sp-point">'
        + '  <div class="sp-point-head">'
        + '    <div class="sp-crumb">' + esc(p.chapterTitle) + '</div>'
        + '    <h2>' + esc(p.title) + '</h2>'
        + '    <div class="sp-point-meta">'
        + '      <span class="sp-freq" title="考频估计">' + stars(p.frequency) + '</span>'
        + (p.examTypes || []).map(function (t) {
          return '<span class="sp-type">' + esc(TYPE_LABEL[t] || t) + '</span>';
        }).join('')
        + (answeredCount ? '<span class="sp-mine">我练过 ' + answeredCount + ' 题 · 对 ' + mine.correct + '</span>' : '')
        + '    </div>'
        + '  </div>'
        + '  <div class="sp-core"><span class="sp-core-tag">一句话结论</span><p>' + window.Md.toHtml(p.core) + '</p></div>'
        + (p.detail ? '<div class="sp-detail"><h4>展开讲</h4><p>' + window.Md.toHtml(p.detail) + '</p></div>' : '')
        + (p.keys && p.keys.length
          ? '<div class="sp-keys"><h4>关键词</h4><div class="sp-chips">'
            + p.keys.map(function (k) { return '<span class="sp-key">' + esc(k) + '</span>'; }).join('')
            + '</div></div>' : '')
        + (p.traps && p.traps.length
          ? '<div class="sp-traps"><h4>易错提醒</h4><ul>'
            + p.traps.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('')
            + '</ul></div>' : '')
        + '  <div class="sp-actions">'
        + '    <button class="btn btn-primary" data-act="explain">AI 讲解这个考点</button>'
        + '    <button class="btn" data-act="similar">找类似题（真题优先）</button>'
        + '    <button class="btn btn-ghost" data-act="generate">AI 再出 3 道</button>'
        + '  </div>'
        + '  <div class="sp-ai" id="spAi"' + (state.aiText ? '' : ' hidden') + '>'
        + '    <div class="sp-ai-head"><span>讲解</span><span class="sp-ai-mode">' + esc(modeLabel(state.aiMode)) + '</span></div>'
        + '    <div class="sp-ai-body" id="spAiBody"></div>'
        + '  </div>'
        + '  <div class="sp-qwrap" id="spQuestions"></div>'
        + '</article>';
    }

    function modeLabel(mode) {
      if (mode === 'user-key') return '我的模型';
      if (mode === 'site') return '站点模型';
      if (mode === 'free') return '免费通道';
      if (mode === 'local') return '本地精讲';
      return '';
    }

    function renderAi() {
      const box = document.getElementById('spAi');
      const body = document.getElementById('spAiBody');
      if (!box || !body) return;
      if (!state.aiText) { box.hidden = true; return; }
      box.hidden = false;
      body.innerHTML = window.Md.toHtml(state.aiText);
      window.Md.renderMath(body);
    }

    function questionHTML(q, idx) {
      const answered = state.answered[q.id];
      const isChoice = q.type === 'single';
      const isJudge = q.type === 'judge';
      let input = '';
      if (isChoice) {
        input = '<div class="sp-opts">' + (q.options || []).map(function (opt, i) {
          const letter = String.fromCharCode(65 + i);
          const text = String(opt || '').replace(/^[A-D][.、\s]*/, '');
          let cls = '';
          if (answered && !answered.needsHuman) {
            if (answered.expected === letter) cls = ' correct';
            else if (answered.got === letter) cls = ' wrong';
          }
          return '<button class="sp-opt' + cls + '" data-ans="' + letter + '" data-q="' + esc(q.id) + '">'
            + '<b>' + letter + '</b><span>' + window.Md.toHtml(text) + '</span></button>';
        }).join('') + '</div>';
      } else if (isJudge) {
        input = '<div class="sp-opts sp-opts-judge">'
          + ['对', '错'].map(function (v) {
            const cls = answered && answered.got === v ? (answered.correct ? ' correct' : ' wrong') : '';
            return '<button class="sp-opt' + cls + '" data-ans="' + v + '" data-q="' + esc(q.id) + '">' + v + '</button>';
          }).join('') + '</div>';
      } else {
        input = '<textarea class="sp-write" data-write="' + esc(q.id) + '" rows="3" '
          + 'placeholder="先自己写，再对照答案（写在这儿不会被保存）"></textarea>'
          + '<div class="sp-opts"><button class="btn btn-sm" data-act="reveal" data-q="' + esc(q.id) + '">看答案与解析</button>'
          + '<button class="btn btn-sm btn-ghost" data-act="aigrade" data-q="' + esc(q.id) + '">AI 批改</button></div>';
      }
      const res = answered
        ? '<div class="sp-q-res ' + (answered.needsHuman ? '' : (answered.correct ? 'ok' : 'bad')) + '">'
          + (answered.needsHuman
            ? '<b>参考答案 / 得分点</b>'
            : (answered.correct ? '<b>✓ 正确</b>' : '<b>✗ 不对</b> <span>正确答案 ' + esc(answered.expected || '') + '</span>'))
          + (answered.explain ? '<div class="sp-sol">' + window.Md.toHtml(answered.explain) + '</div>' : '')
          + (answered.ai ? '<div class="sp-ai-grade">' + window.Md.toHtml(answered.ai) + '</div>' : '')
          + '</div>'
        : '';
      return ''
        + '<div class="sp-q" data-qid="' + esc(q.id) + '">'
        + '  <div class="sp-q-head">'
        + '    <span class="sp-q-no">' + (idx + 1) + '</span>'
        + '    <span class="sp-type">' + esc(q.typeName || TYPE_LABEL[q.type] || q.type) + '</span>'
        + (q.isPast ? '<span class="sp-past">真题</span>' : '<span class="sp-own">练习</span>')
        + (q.source ? '<span class="sp-q-src">' + esc(String(q.source).slice(0, 28)) + '</span>' : '')
        + '  </div>'
        + '  <div class="sp-q-stem">' + window.Md.toHtml(q.stem || '') + '</div>'
        + input + res
        + '</div>';
    }

    function renderQuestions() {
      const box = document.getElementById('spQuestions');
      if (!box) return;
      if (!state.questions.length) {
        box.innerHTML = '<div class="sp-q-empty">这个考点还没有包内题目，点上面的「AI 再出 3 道」让模型出题，或换个考点。</div>';
        return;
      }
      const past = state.questions.filter(function (q) { return q.isPast; }).length;
      box.innerHTML = '<div class="sp-q-title">练一练'
        + (past ? '<span class="sp-q-note">其中 ' + past + ' 道来自往年卷</span>' : '')
        + '</div>'
        + state.questions.map(questionHTML).join('');
      window.Md.renderMath(box);
    }

    /* ------------------------------------------------------------ 薄弱 */

    function paneWeakHTML() {
      const w = state.weak;
      if (!w) return '<div class="sp-loading">正在分析…</div>';
      const s = w.summary || {};
      const acc = s.attempts ? Math.round(((s.attempts - w.items.reduce(function (a, b) { return a + (b.attempts - b.correct); }, 0)) / s.attempts) * 100) : null;
      const chapters = (w.chapters || []).slice(0, 8);
      return ''
        + '<div class="sp-weak">'
        + '  <div class="sp-stats">'
        + '    <div class="stat"><div class="k">已学考点</div><div class="v">' + (s.touched || 0) + '<small>/' + (s.totalPoints || 0) + '</small></div></div>'
        + '    <div class="stat"><div class="k">薄弱考点</div><div class="v">' + (s.weak || 0) + '</div></div>'
        + '    <div class="stat"><div class="k">做题</div><div class="v">' + (s.attempts || 0) + '</div></div>'
        + '    <div class="stat"><div class="k">正确率</div><div class="v">' + (acc === null ? '—' : acc + '%') + '</div></div>'
        + '  </div>'
        + (s.attempts || s.asks
          ? ''
          : '<div class="sp-tip">还没有答题记录。先去「学习知识点」做几道题，这里就会按错题率、提问次数和看答案次数排序。</div>')
        + (chapters.length
          ? '<div class="sp-block"><h4>薄弱板块</h4>' + chapters.map(function (c) {
            return '<div class="sp-bar-row">'
              + '<span class="sp-bar-label">' + esc(c.chapterTitle) + '</span>'
              + '<span class="sp-bar"><i style="width:' + Math.min(100, c.score) + '%"></i></span>'
              + '<span class="sp-bar-val">' + c.score + '</span>'
              + '</div>';
          }).join('') + '</div>'
          : '')
        + ((w.items || []).length
          ? '<div class="sp-block"><h4>最该补的考点</h4><div class="sp-weak-list">'
            + w.items.slice(0, 10).map(function (it) {
              return '<button class="sp-weak-item ' + it.level + '" data-point="' + esc(it.pointId) + '">'
                + '<span class="sp-weak-score">' + it.score + '</span>'
                + '<span class="sp-weak-main"><b>' + esc(it.title) + '</b>'
                + '<em>' + esc(it.chapterTitle) + '</em></span>'
                + '<span class="sp-weak-num">' + (it.accuracy === null ? '未练' : '正确率 ' + it.accuracy + '%')
                + (it.asks ? ' · 问过 ' + it.asks + ' 次' : '') + '</span>'
                + '</button>';
            }).join('') + '</div></div>'
          : '')
        + '  <div class="sp-actions">'
        + '    <button class="btn btn-primary" data-act="plan">生成突击方案</button>'
        + '    <span class="sp-hint">方案会按薄弱度和剩余考点数排期，可直接照着做</span>'
        + '  </div>'
        + '  <div class="sp-plan" id="spPlan"' + (state.plan ? '' : ' hidden') + '>'
        + '    <div class="sp-plan-head">突击方案<span class="sp-ai-mode">' + esc(state.planMode || '') + '</span></div>'
        + '    <div class="sp-plan-body" id="spPlanBody"></div>'
        + '  </div>'
        + '</div>';
    }

    function renderPlan() {
      const box = document.getElementById('spPlan');
      const body = document.getElementById('spPlanBody');
      if (!box || !body) return;
      if (!state.plan) { box.hidden = true; return; }
      box.hidden = false;
      body.innerHTML = window.Md.toHtml(state.plan);
      window.Md.renderMath(body);
    }

    function renderPane() {
      const pane = document.getElementById('spPane');
      if (!pane) return;
      const work = el.querySelector('.sp-work');
      if (work) work.classList.toggle('wide', state.tab === 'vocab');
      if (state.tab === 'weak') pane.innerHTML = paneWeakHTML();
      else if (state.tab === 'vocab') pane.innerHTML = paneVocabHTML();
      else pane.innerHTML = paneStudyHTML();
      if (state.tab === 'weak') {
        renderPlan();
      } else if (state.tab === 'vocab') {
        /* 词卡里没有数学公式，不用再跑一遍 KaTeX */
      } else {
        renderAi();
        renderQuestions();
      }
    }

    /* ------------------------------------------------------------ 背单词 */

    function vocabStatsHTML() {
      const s = state.vocab.stats || {};
      return ''
        + '<div class="sp-vocab-stats">'
        + '  <span><b>' + (s.total || state.pack.counts.vocab || 0) + '</b> 词库</span>'
        + '  <span><b>' + (s.learned || 0) + '</b> 已学</span>'
        + '  <span class="due"><b>' + (s.due || 0) + '</b> 待复习</span>'
        + '  <span><b>' + (s.fresh === undefined ? '—' : s.fresh) + '</b> 未学</span>'
        + '  <span class="today"><b>' + (s.today || 0) + '</b> 今日</span>'
        + '</div>';
    }

    function vocabCardHTML(w) {
      const v = state.vocab;
      const show = v.revealed || v.quick;
      const kind = w.kind === 'due'
        ? '<span class="vc-kind due">复习' + (w.overdueDays ? ' · 逾期 ' + w.overdueDays + ' 天' : '') + '</span>'
        : '<span class="vc-kind">新词</span>';
      const mean = show
        ? '<div class="vc-mean">'
          + '<div class="vc-cn">' + esc(w.cn || '') + '</div>'
          + (w.ex ? '<div class="vc-ex">' + esc(w.ex) + (w.exCn ? '<em>' + esc(w.exCn) + '</em>' : '') + '</div>' : '')
          + ((w.syn || []).length
            ? '<div class="vc-syn">' + w.syn.map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('') + '</div>'
            : '')
          + '</div>'
        : '<button class="vc-mask" data-act="vshow">点击显示释义<span>或按空格</span></button>';
      return ''
        + '<div class="vc-card' + (show ? ' revealed' : '') + '">'
        + '  <div class="vc-top">' + kind
        + (w.reps ? '<span class="vc-reps">已复习 ' + w.reps + ' 次</span>' : '')
        + (w._rep ? '<span class="vc-reps">本轮重来第 ' + w._rep + ' 次</span>' : '')
        + '  </div>'
        + '  <div class="vc-word">' + esc(w.w || '') + '</div>'
        + '  <div class="vc-meta">'
        + (w.ph ? '<span class="vc-ph">/' + esc(w.ph) + '/</span>' : '')
        + (w.pos ? '<span class="vc-pos">' + esc(w.pos) + '</span>' : '')
        + '  </div>'
        + '  <div class="vc-body">' + mean + '</div>'
        + '  <div class="vc-rate">'
        + '    <button class="vc-btn again" data-rate="again"><b>不认识</b><kbd>1</kbd></button>'
        + '    <button class="vc-btn hard" data-rate="hard"><b>模糊</b><kbd>2</kbd></button>'
        + '    <button class="vc-btn good" data-rate="good"><b>认识</b><kbd>3</kbd></button>'
        + '  </div>'
        + '  <div class="vc-foot"><button class="vc-skip" data-act="vskip">跳过这个词（不计入）</button></div>'
        + '</div>';
    }

    function paneVocabHTML() {
      const v = state.vocab;
      const head = ''
        + '<div class="sp-vocab-top">'
        + vocabStatsHTML()
        + '  <div class="sp-vocab-modes">'
        + ['mix', 'due', 'new'].map(function (m) {
          const label = m === 'mix' ? '混合' : (m === 'due' ? '只复习' : '只背新词');
          return '<button class="chip' + (v.mode === m ? ' active' : '') + '" data-vmode="' + m + '">' + label + '</button>';
        }).join('')
        + '    <button class="chip' + (v.quick ? ' active' : '') + '" data-act="vquick">速览模式' + (v.quick ? ' 开' : ' 关') + '</button>'
        + '  </div>'
        + '</div>'
        + (!state.loggedIn
          ? '<div class="sp-tip">没登录也能背，但这一轮的进度不会被记住。登录后才会按 FSRS 排下次复习。</div>'
          : '');

      if (v.loading) return head + '<div class="sp-loading">正在取词…</div>';
      if (v.err) return head + '<div class="empty">' + esc(v.err) + '</div>';

      if (v.finished || !v.queue.length) {
        const c = v.counts || {};
        return head
          + '<div class="vc-done">'
          + '  <div class="vc-done-title">' + (v.finished ? '这一轮走完了' : '这个模式下暂时没有词') + '</div>'
          + '  <div class="vc-done-sub">'
          + (v.finished
            ? '认识 ' + (c.good || 0) + ' · 模糊 ' + (c.hard || 0) + ' · 不认识 ' + (c.again || 0)
            : '「只复习」需要先学过一些词，或者先把模式切回「混合」')
          + '  </div>'
          + ((v.stats && v.stats.today) ? '<div class="vc-done-sub">今天累计背了 ' + v.stats.today + ' 个词</div>' : '')
          + '  <div class="vc-done-acts">'
          + '    <button class="btn btn-primary" data-act="vnext">再来一轮（20 个）</button>'
          + '    <button class="btn" data-act="vdue">只复习到期的</button>'
          + '  </div>'
          + '</div>';
      }

      const w = v.queue[0];
      const total = v.done + v.queue.length;
      const pct = total ? Math.round((v.done / total) * 100) : 0;
      return head
        + '<div class="sp-vocab-run">'
        + '  <div class="vc-progress"><i style="width:' + pct + '%"></i></div>'
        + '  <div class="vc-progress-txt">已过 ' + v.done + ' 张 · 还剩 ' + v.queue.length + ' 张</div>'
        + vocabCardHTML(w)
        + '  <div class="vc-keys"><kbd>空格</kbd> 显示释义 · <kbd>1</kbd> 不认识 · <kbd>2</kbd> 模糊 · <kbd>3</kbd> 认识'
        + '<em>不认识的词会在三张之后再出现一次，评价会按 FSRS 排下次复习</em></div>'
        + '</div>';
    }

    function renderVocab() {
      const pane = document.getElementById('spPane');
      if (!pane || state.tab !== 'vocab') return;
      pane.innerHTML = paneVocabHTML();
    }

    async function loadVocab(mode) {
      const v = state.vocab;
      v.mode = mode || v.mode || 'mix';
      v.loading = true;
      v.finished = false;
      v.err = '';
      v.revealed = false;
      v.done = 0;
      v.queue = [];
      v.counts = { again: 0, hard: 0, good: 0 };
      renderVocab();
      try {
        const d = await API.get('/api/sprint/packs/' + packId + '/vocab?limit=20&mode=' + encodeURIComponent(v.mode));
        v.queue = d.items || [];
        v.stats = d.stats || v.stats;
        if (v.quick) v.revealed = true;
      } catch (e) {
        v.err = e.message || '取词失败';
      }
      v.loading = false;
      renderVocab();
    }

    function revealVocab() {
      const v = state.vocab;
      if (state.tab !== 'vocab' || v.finished || v.loading || !v.queue.length) return;
      if (v.revealed) return;
      v.revealed = true;
      renderVocab();
    }

    function rateVocab(rating) {
      const v = state.vocab;
      if (state.tab !== 'vocab' || v.finished || v.loading) return;
      /* 当前卡恒为队首：出队后下一张自然补到 0 位，不用维护游标 */
      const w = v.queue[0];
      if (!w) return;
      v.counts[rating] = (v.counts[rating] || 0) + 1;
      v.done += 1;

      /* 队列推进：不认识 → 三张之后重来；模糊 → 本轮末尾再过一遍；认识 → 出队。
         两种重复各自最多两次，避免同一个词把一轮拖成死循环。 */
      if (rating === 'again' && (w._rep || 0) < 2) {
        w._rep = (w._rep || 0) + 1;
        const card = v.queue.shift();
        v.queue.splice(Math.min(v.queue.length, 3), 0, card);
      } else if (rating === 'hard' && !w._hard) {
        w._hard = 1;
        v.queue.push(v.queue.shift());
      } else {
        v.queue.shift();
      }
      v.revealed = v.quick;
      if (!v.queue.length) v.finished = true;
      renderVocab();

      if (!state.loggedIn) return;
      API.post('/api/sprint/packs/' + packId + '/vocab', { word: w.w, rating: rating }).then(function (d) {
        if (!d.stats) return;
        state.vocab.stats = d.stats;
        const box = document.querySelector('.sp-vocab-stats');
        if (box && state.tab === 'vocab') box.outerHTML = vocabStatsHTML();
        /* 收尾页上的「今天累计背了 N 个词」是在最后一次 POST 回来之前渲染的，
           这里补一次重绘，否则永远显示成第一张时的数字 */
        if (state.vocab.finished && state.tab === 'vocab') renderVocab();
      }).catch(function (e) {
        UI.toast(e.message || '记录失败', 'err');
      });
    }

    /* 跳过：不评价、不计数，只是把这张挪到本轮末尾，下次再遇到 */
    function skipVocab() {
      const v = state.vocab;
      if (state.tab !== 'vocab' || v.finished || v.loading || !v.queue.length) return;
      if (v.queue.length <= 1) {
        v.queue.shift();
        v.finished = true;
      } else {
        v.queue.push(v.queue.shift());
      }
      v.revealed = v.quick;
      renderVocab();
    }


    /* ------------------------------------------------------------ 数据动作 */

    async function loadPoint(pid) {
      if (!pid) return;
      state.pointId = pid;
      state.aiText = '';
      state.aiMode = '';
      state.questions = [];
      state.answered = {};
      renderChapters();
      const pane = document.getElementById('spPane');
      if (pane && state.tab === 'study') pane.innerHTML = '<div class="sp-loading">加载考点…</div>';
      try {
        const d = await API.get('/api/sprint/packs/' + packId + '/points/' + encodeURIComponent(pid));
        state.point = d.point;
        state.mine = state.mine || {};
        state.mine.point = d.mine;
        if (d.point && d.point.chapter) state.openChapter = d.point.chapter;
        renderChapters();
        renderPane();
        loadSimilar(false);
      } catch (e) {
        UI.toast(e.message || '考点加载失败', 'err');
      }
    }

    async function loadSimilar(generate) {
      if (!state.point) return;
      try {
        const d = await API.post('/api/sprint/packs/' + packId + '/similar', {
          pointId: state.point.id,
          limit: 5,
          generate: !!generate
        });
        const extra = d.items || [];
        const seen = {};
        state.questions = extra.filter(function (q) {
          if (seen[q.id]) return false;
          seen[q.id] = 1;
          return true;
        });
        renderQuestions();
        if (d.note) UI.toast(d.note, 'ok');
      } catch (e) {
        UI.toast(e.message || '题目加载失败', 'err');
      }
    }

    async function explain(question) {
      if (!UI.requireLogin(null, '登录后才能用 AI 讲解（记录提问会用于薄弱分析）')) return;
      const btn = document.querySelector('[data-act="explain"]');
      if (btn) { btn.disabled = true; btn.textContent = '讲解中…'; }
      state.aiText = '正在生成…';
      state.aiMode = '';
      renderAi();
      try {
        const d = await API.post('/api/sprint/packs/' + packId + '/explain', {
          pointId: state.point.id,
          question: question || ''
        });
        state.aiText = d.text || '';
        state.aiMode = d.mode || '';
      } catch (e) {
        state.aiText = '讲解失败：' + (e.message || '');
      }
      if (btn) { btn.disabled = false; btn.textContent = 'AI 讲解这个考点'; }
      renderAi();
      const box = document.getElementById('spAi');
      if (box) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async function answer(qid, value) {
      if (!UI.requireLogin(null, '登录后答题才会记入薄弱分析')) return;
      const q = state.questions.filter(function (x) { return x.id === qid; })[0];
      try {
        const d = await API.post('/api/sprint/packs/' + packId + '/answer', {
          questionId: qid,
          answer: value
        });
        state.answered[qid] = {
          correct: d.correct,
          expected: d.expected,
          got: d.got || value,
          explain: d.explain,
          answer: d.answer,
          needsHuman: !!d.needsHuman
        };
        renderQuestions();
        if (!d.needsHuman) UI.toast(d.correct ? '答对了' : '再看一眼解析', d.correct ? 'ok' : 'err');
        if (q) updateMineAfter(q);
      } catch (e) {
        UI.toast(e.message || '提交失败', 'err');
      }
    }

    async function reveal(qid) {
      try {
        const d = await API.post('/api/sprint/packs/' + packId + '/reveal', { questionId: qid });
        state.answered[qid] = state.answered[qid] || {};
        state.answered[qid].needsHuman = true;
        state.answered[qid].answer = d.answer;
        state.answered[qid].explain = d.explain;
        renderQuestions();
      } catch (e) {
        UI.toast(e.message || '获取答案失败', 'err');
      }
    }

    async function aiGrade(qid) {
      if (!UI.requireLogin(null, '登录后才能让 AI 批改')) return;
      const ta = document.querySelector('[data-write="' + qid + '"]');
      const text = ta ? String(ta.value || '').trim() : '';
      if (text.length < 8) { UI.toast('先写几行答案再让 AI 批改', 'err'); return; }
      try {
        const d = await API.post('/api/sprint/packs/' + packId + '/answer', {
          questionId: qid,
          answer: text,
          aiGrade: true
        });
        state.answered[qid] = {
          needsHuman: true,
          answer: d.answer,
          explain: d.explain,
          ai: d.ai
        };
        renderQuestions();
      } catch (e) {
        UI.toast(e.message || 'AI 批改失败', 'err');
      }
    }

    function updateMineAfter(q) {
      if (!state.mine) return;
      state.mine.attempts = (state.mine.attempts || 0) + 1;
      const set = {};
      (q.points || []).forEach(function (pid) { set[pid] = 1; });
      const touched = state.mine._touched || {};
      Object.keys(set).forEach(function (pid) { touched[pid] = 1; });
      state.mine._touched = touched;
      state.mine.touchedPoints = Object.keys(touched).length;
      const hint = document.querySelector('.sp-tabs-hint');
      if (hint) hint.textContent = '已练 ' + state.mine.attempts + ' 题 · 学过 ' + state.mine.touchedPoints + ' 个考点';
    }

    async function loadWeak() {
      const pane = document.getElementById('spPane');
      if (pane) pane.innerHTML = '<div class="sp-loading">正在分析…</div>';
      try {
        const d = await API.get('/api/sprint/packs/' + packId + '/weak');
        state.weak = d.weak;
      } catch (e) {
        state.weak = { items: [], chapters: [], summary: { totalPoints: 0 } };
        UI.toast(e.message || '分析失败', 'err');
      }
      renderChapters();
      renderPane();
    }

    async function plan() {
      if (!UI.requireLogin(null, '登录后才能按你的记录生成方案')) return;
      const btn = document.querySelector('[data-act="plan"]');
      if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
      try {
        const d = await API.post('/api/sprint/packs/' + packId + '/plan', { days: 3 });
        state.plan = d.text || '';
        state.planMode = d.mode === 'ai' ? 'AI 生成' : '规则生成';
        renderPlan();
      } catch (e) {
        UI.toast(e.message || '生成失败', 'err');
      }
      if (btn) { btn.disabled = false; btn.textContent = '生成突击方案'; }
    }

    /* ------------------------------------------------------------ 事件 */

    function onHashPoint(e) {
      const btn = e.target.closest('[data-point]');
      if (!btn) return;
      const pid = btn.getAttribute('data-point');
      if (state.tab !== 'study') {
        state.tab = 'study';
        const tab = document.querySelector('[data-tab="study"]');
        if (tab) tab.classList.add('active');
        const other = document.querySelector('[data-tab="weak"]');
        if (other) other.classList.remove('active');
      }
      /* 不写 location.hash：切换考点只换右侧面板，写 hash 会触发整页重渲染并留下一条历史记录 */
      loadPoint(pid);
    }
    function onClick(e) {
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) {
        const next = tabBtn.getAttribute('data-tab');
        if (next === state.tab) return;
        state.tab = next;
        document.querySelectorAll('.sp-tab').forEach(function (b) { b.classList.toggle('active', b === tabBtn); });
        if (next === 'weak') loadWeak();
        else if (next === 'vocab') {
          renderPane();
          if (!state.vocab.queue.length && !state.vocab.loading) loadVocab(state.vocab.mode);
        } else renderPane();
        return;
      }

      const rateBtn = e.target.closest('[data-rate]');
      if (rateBtn) { rateVocab(rateBtn.getAttribute('data-rate')); return; }

      const vmode = e.target.closest('[data-vmode]');
      if (vmode) { loadVocab(vmode.getAttribute('data-vmode')); return; }

      const chBtn = e.target.closest('[data-chapter]');
      if (chBtn) {
        const cid = chBtn.getAttribute('data-chapter');
        const ch = state.chapters.filter(function (c) { return c.id === cid; })[0];
        if (!ch) return;
        if (state.openChapter === cid) {
          state.openChapter = '';
          renderChapters();
          return;
        }
        state.openChapter = cid;
        renderChapters();
        /* 展开后如果当前考点不在这一章，自动选中该章第一个考点，省一次点击 */
        const inside = state.point && state.point.chapter === cid;
        if (!inside && state.tab === 'study' && ch.points[0]) loadPoint(ch.points[0].id);
        return;
      }

      const pointBtn = e.target.closest('[data-point]');
      if (pointBtn) { onHashPoint(e); return; }

      const opt = e.target.closest('[data-ans]');
      if (opt) {
        answer(opt.getAttribute('data-q'), opt.getAttribute('data-ans'));
        return;
      }

      const act = e.target.closest('[data-act]');
      if (!act) return;
      const what = act.getAttribute('data-act');
      if (what === 'explain') explain('');
      else if (what === 'similar') loadSimilar(false);
      else if (what === 'generate') loadSimilar(true);
      else if (what === 'reveal') reveal(act.getAttribute('data-q'));
      else if (what === 'aigrade') aiGrade(act.getAttribute('data-q'));
      else if (what === 'plan') plan();
      else if (what === 'vshow') revealVocab();
      else if (what === 'vskip') skipVocab();
      else if (what === 'vnext') loadVocab('mix');
      else if (what === 'vdue') loadVocab('due');
      else if (what === 'vquick') {
        state.vocab.quick = !state.vocab.quick;
        state.vocab.revealed = state.vocab.quick;
        renderVocab();
      }
    }

    /* 背单词的键盘流：空格看释义，1/2/3 评价。输入框里打字时不抢键。 */
    function onKey(e) {
      if (state.tab !== 'vocab' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        revealVocab();
        return;
      }
      const rating = RATE_KEYS[e.key];
      if (rating) {
        e.preventDefault();
        rateVocab(rating);
      }
    }

    /* ------------------------------------------------------------ 启动 */

    API.get('/api/sprint/packs/' + encodeURIComponent(packId)).then(function (d) {
      state.pack = d.pack;
      state.chapters = d.chapters || [];
      state.mine = d.me || {};
      state.loggedIn = !!d.me;
      /* 默认展开：带 ?p= 时展开该考点所在章节，否则展开第一章 */
      if (!state.openChapter) {
        const pid = state.pointId || (state.chapters[0] && state.chapters[0].points[0] && state.chapters[0].points[0].id);
        state.chapters.some(function (ch) {
          if (ch.points.some(function (pt) { return pt.id === pid; })) { state.openChapter = ch.id; return true; }
          return false;
        });
        if (!state.openChapter && state.chapters[0]) state.openChapter = state.chapters[0].id;
      }
      el.innerHTML = shellHTML();
      el.addEventListener('click', onClick);
      document.addEventListener('keydown', onKey);

      if (state.tab === 'weak') {
        renderChapters();
        loadWeak();
        return;
      }
      if (state.tab === 'vocab') {
        renderChapters();
        renderPane();
        loadVocab(state.vocab.mode);
        return;
      }
      const first = state.pointId || (state.chapters[0] && state.chapters[0].points[0] && state.chapters[0].points[0].id);
      if (first) loadPoint(first);
      else {
        renderChapters();
        renderPane();
      }
    }).catch(function (e) {
      el.innerHTML = '<div class="empty" style="margin-top:40px"><b>科目加载失败</b>'
        + esc(e.message || '') + '<div style="margin-top:14px"><a class="btn" href="#/sprint">返回列表</a></div></div>';
    });

    return function cleanup() {
      el.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  };
})();
