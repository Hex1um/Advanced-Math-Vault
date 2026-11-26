/* 学习分析：刷题热力图 + 主考点掌握度 + 薄弱点靶向推荐
   数据来自 /api/analytics/overview（一次请求拿全，避免首屏多次往返）。 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};
  const St = window.API.State;

  const COURSE_NAME = {
    general: '普通物理', mmp: '数学物理方法', theory: '四大力学',
    astro: '天体物理与天文', lab: '实验与实测天文', misc: '综合'
  };

  function courseRow(c) {
    const name = COURSE_NAME[c.course] || c.course;
    const val = c.attempts ? (c.avgScore || 0) : 0;
    return '<div class="mastery-row" style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px dashed var(--line, #e6e8ec)">'
      + '<span style="flex:0 0 104px;font-size:12.5px">' + window.Md.esc(name) + '</span>'
      + '<span style="flex:1;height:6px;background:var(--line,#e6e8ec);border-radius:3px;overflow:hidden">'
      + '<span style="display:block;height:100%;width:' + Math.min(100, Math.max(0, val)) + '%;background:var(--blue,#2f6fed)"></span></span>'
      + '<span class="small muted" style="flex:0 0 96px;text-align:right">'
      + (c.attempts ? ('均分 ' + c.avgScore + ' · ' + c.solved + ' 题') : '未涉及') + '</span></div>';
  }

  function masteryRow(m) {
    const pct = Math.max(0, Math.min(100, m.score));
    const tone = pct >= 75 ? 'var(--green)' : pct >= 45 ? 'var(--amber, #d9930a)' : 'var(--red)';
    return '<div class="mastery-row" style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px dashed var(--line, #e6e8ec)">'
      + '<span style="flex:0 0 108px;font-size:13px">' + window.Md.esc(m.mainTag) + '</span>'
      + '<span style="flex:1;height:8px;border-radius:5px;background:var(--surface-2,#f2f4f7);overflow:hidden">'
      + '<span style="display:block;height:100%;width:' + pct + '%;background:' + tone + '"></span></span>'
      + '<span style="flex:0 0 46px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums">' + pct + '</span>'
      + '<span class="muted small" style="flex:0 0 128px;text-align:right">' + m.attempts + ' 次 / 对 ' + m.uniqueSolved + ' 题</span>'
      + '</div>';
  }

  function recommendList(items) {
    if (!items || !items.length) return '<div class="small muted">暂无推荐：先做几道题，系统才能找到薄弱点。</div>';
    return items.map(function (p) {
      return '<a class="related-item" href="#/problem/' + p.code + '">'
        + '<span class="code">' + p.code + '</span>'
        + '<span class="t">' + window.Md.inlineTex(p.title) + '</span>'
        + '<span class="tag">' + window.Md.esc(p.mainTag || '') + ' · 难度 ' + p.difficulty + '</span></a>';
    }).join('');
  }

  Views.analytics = function (el) {
    const me = St.me;
    el.innerHTML = '<div class="page-head"><div><h1>学习分析</h1>'
      + '<p class="sub">看得到进步，才知道下一步练什么：热力图记录每天的投入，掌握度指出该补的考点。</p></div></div>'
      + '<div class="loading-row"><span class="spinner"></span>正在统计你的做题记录…</div>';

    if (!me) {
      el.innerHTML = '<div class="page-head"><div><h1>学习分析</h1></div></div>'
        + window.UI.empty('登录后才有学习分析', '做题记录、错题本与掌握度都绑定在账号上。');
      return;
    }

    window.API.get(window.API.State.withSubject('/api/analytics/overview')).then(function (d) {
      el.innerHTML =
        '<div class="page-head"><div><h1>学习分析</h1>'
        + '<p class="sub">累计提交 ' + d.totalSubmissions + ' 次，做出 ' + d.totalSolved + ' 题；'
        + '当前连续打卡 <b>' + d.streak + '</b> 天，最长 ' + d.bestStreak + ' 天。</p></div>'
        + '<div class="head-actions"><a class="btn" href="#/wrong">去复习错题</a>'
        + '<a class="btn btn-primary" href="#/practice?focus=weak">练薄弱考点</a></div></div>'
        + '<section class="card" style="padding:16px 18px;margin-bottom:16px">'
        + '<div class="small muted" style="margin-bottom:10px">近 26 周刷题热力图</div>'
        + '<div id="heatmapBox"></div></section>'
        + '<div class="grid-2" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px">'
        + (d.courses && d.courses.length
          ? '<section class="card" style="padding:16px 18px;grid-column:1/-1"><div class="small muted" style="margin-bottom:6px">课程组掌握度（按课程看均分与做题量）</div>'
            + d.courses.map(courseRow).join('') + '</section>'
          : '')
        + '<section class="card" style="padding:16px 18px"><div class="small muted" style="margin-bottom:6px">主考点掌握度（越低越该练）</div>'
        + (d.mastery && d.mastery.length ? d.mastery.map(masteryRow).join('') : '<div class="small muted">还没有足够数据。</div>')
        + '<div class="small muted" style="margin-top:10px">掌握度 = 正确率 70% + 覆盖度 30%（覆盖 15 题记满）。</div></section>'
        + '<section class="card" style="padding:16px 18px"><div class="small muted" style="margin-bottom:6px">靶向推荐（薄弱考点 · 还没做过的题）</div>'
        + recommendList(d.recommended) + '</section></div>';

      if (window.MathVaultHeatmap) {
        window.MathVaultHeatmap.renderHeatmap(document.getElementById('heatmapBox'), d.heatmap, 26);
      }
    }).catch(function (e) {
      const notReady = e && e.status === 404;
      el.innerHTML = '<div class="page-head"><div><h1>学习分析</h1></div></div>'
        + window.UI.empty(notReady ? '后端还没升级到 v2.0' : '统计加载失败',
          notReady ? '学习分析需要 v2.0 后端（/api/analytics/overview）。部署新版本后刷新即可。'
            : (window.API.describe ? window.API.describe(e) : '稍后再试。'));
    });
  };

  /* #/practice?focus=weak：抽一道薄弱考点的未做题后直接跳转，不额外占一个页面 */
  Views.practice = function (el, params) {
    el.innerHTML = '<div class="loading-row"><span class="spinner"></span>正在挑一道适合你的题…</div>';
    const q = params && params.focus === 'weak' ? '?focus=weak&mode=random' : '?mode=random';
    window.API.get(window.API.State.withSubject('/api/practice' + q)).then(function (r) {
      if (r && r.code) { location.replace('#/problem/' + r.code); return; }
      el.innerHTML = window.UI.empty('这个范围暂时没有未做的题', '换一个考点，或去题库自己挑一道。');
    }).catch(function (e) {
      el.innerHTML = window.UI.empty('挑题失败', window.API.describe ? window.API.describe(e) : '稍后再试。');
    });
  };
})();
