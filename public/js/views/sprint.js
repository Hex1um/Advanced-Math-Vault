/* 期末突击 · 科目选择页
   数据来自 /api/sprint/packs：每个科目包 = 一个学校 + 一门课 + 一个学年，
   里面是「章节 → 考点 → 题目」和一份考试蓝图。 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};
  const St = window.API.State;

  function fmtExam(exam) {
    if (!exam || !exam.sections) return '';
    return exam.sections.map(function (s) {
      return '<span class="sp-sec"><b>' + window.Md.esc(s.name) + '</b> ' + s.points + '′</span>';
    }).join('');
  }

  function progressOf(pack, mine) {
    const m = (mine || {})[pack.id];
    if (!m) return { attempts: 0, points: 0, pct: 0 };
    const pct = pack.counts.points ? Math.min(100, Math.round((m.points / pack.counts.points) * 100)) : 0;
    return { attempts: m.attempts || 0, points: m.points || 0, pct: pct };
  }

  function cardHTML(pack, mine) {
    const p = progressOf(pack, mine);
    return ''
      + '<a class="sp-card" href="#/sprint/' + encodeURIComponent(pack.id) + '">'
      + '  <div class="sp-card-top">'
      + '    <span class="sp-school">' + window.Md.esc(pack.schoolShort || pack.school) + '</span>'
      + '    <span class="sp-year">' + window.Md.esc(pack.year) + ' · ' + window.Md.esc(pack.term || '') + '</span>'
      + (pack.private ? '<span class="sp-priv" title="只有指定账号能看到这个科目包">仅你可见</span>' : '')
      + '  </div>'
      + '  <h3>' + window.Md.esc(pack.subject) + '</h3>'
      + '  <p class="sp-intro">' + window.Md.esc(pack.intro || '') + '</p>'
      + '  <div class="sp-secs">' + fmtExam(pack.exam) + '</div>'
      + '  <div class="sp-card-stats">'
      + '    <span><b>' + pack.counts.points + '</b> 考点</span>'
      + '    <span><b>' + pack.counts.questions + '</b> 题</span>'
      + '    ' + (pack.counts.past ? '<span class="sp-past"><b>' + pack.counts.past + '</b> 真题</span>' : '')
      + '    ' + (pack.counts.vocab ? '<span class="sp-vocab-tag"><b>' + pack.counts.vocab + '</b> 词</span>' : '')
      + '  </div>'
      + '  <div class="sp-progress"><i style="width:' + p.pct + '%"></i></div>'
      + '  <div class="sp-card-foot">'
      + '    <span>' + (p.attempts ? '已练 ' + p.attempts + ' 题 · 学过 ' + p.points + ' 个考点' : '还没开始') + '</span>'
      + '    <span class="sp-go">进入突击 →</span>'
      + '  </div>'
      + '</a>';
  }

  Views.sprint = function (el) {
    el.innerHTML = ''
      + '<section class="sp-hero">'
      + '  <div class="sp-hero-main">'
      + '    <div class="sp-kicker">期末突击</div>'
      + '    <h1>选一门课，把考点和真题一次打通</h1>'
      + '    <p>每门课都按教材章节拆成考点：先看「一句话结论」和 AI 讲解，再练往年真题；'
      + '    练完在「分析薄弱」里看哪几块最该补，直接生成可执行的三天方案。</p>'
      + '  </div>'
      + '  <div class="sp-hero-side" id="spHeroStats">—</div>'
      + '</section>'
      + '<div class="sp-toolbar" id="spToolbar"></div>'
      + '<div id="spList"><div class="sp-loading">正在加载科目…</div></div>';

    let all = [];
    let school = '';

    function renderList() {
      const box = document.getElementById('spList');
      if (!box) return;
      const list = all.filter(function (p) { return !school || (p.schoolShort || p.school) === school; });
      if (!list.length) {
        box.innerHTML = '<div class="empty" style="margin-top:24px"><b>这个学校还没有科目包</b>'
          + '科目包放在 data/subjects/*.json，加一份就会出现在这里。</div>';
        return;
      }
      box.innerHTML = '<div class="sp-grid">' + list.map(function (p) {
        return cardHTML(p, St.sprintMine || {});
      }).join('') + '</div>';
    }

    function renderToolbar() {
      const box = document.getElementById('spToolbar');
      if (!box) return;
      const schools = [];
      all.forEach(function (p) {
        const s = p.schoolShort || p.school;
        if (schools.indexOf(s) < 0) schools.push(s);
      });
      box.innerHTML = '<div class="chip-scroll">'
        + '<button class="chip' + (!school ? ' active' : '') + '" data-school="">全部学校</button>'
        + schools.map(function (s) {
          return '<button class="chip' + (school === s ? ' active' : '') + '" data-school="' + window.Md.esc(s) + '">'
            + window.Md.esc(s) + '</button>';
        }).join('')
        + '</div>';
    }

    document.getElementById('spToolbar').addEventListener('click', function (e) {
      const btn = e.target.closest('[data-school]');
      if (!btn) return;
      school = btn.getAttribute('data-school') || '';
      renderToolbar();
      renderList();
    });

    window.API.get('/api/sprint/packs').then(function (d) {
      all = d.packs || [];
      St.sprintMine = d.mine || {};
      const hero = document.getElementById('spHeroStats');
      const points = all.reduce(function (s, p) { return s + p.counts.points; }, 0);
      const qs = all.reduce(function (s, p) { return s + p.counts.questions; }, 0);
      const words = all.reduce(function (s, p) { return s + (p.counts.vocab || 0); }, 0);
      if (hero) {
        hero.innerHTML = '<div class="stat"><div class="k">科目</div><div class="v">' + all.length + '</div></div>'
          + '<div class="stat"><div class="k">考点</div><div class="v">' + points + '</div></div>'
          + '<div class="stat"><div class="k">题目</div><div class="v">' + qs + '</div></div>'
          + (words ? '<div class="stat"><div class="k">单词</div><div class="v">' + words + '</div></div>' : '');
      }
      renderToolbar();
      renderList();
    }).catch(function (e) {
      const box = document.getElementById('spList');
      if (box) {
        box.innerHTML = '<div class="empty" style="margin-top:24px"><b>科目加载失败</b>'
          + window.Md.esc(e.message || '') + '</div>';
      }
    });

    return function cleanup() {};
  };
})();
