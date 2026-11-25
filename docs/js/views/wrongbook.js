/* 错题本：没过 80 分线的题都会在这里 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};

  function bindWeakDrill() {
    const btn = document.getElementById('weakDrill');
    if (!btn) return;
    btn.addEventListener('click', function () {
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = '挑题中…';
      window.API.get('/api/practice?focus=weak&mode=random').then(function (r) {
        if (r && r.code) {
          location.hash = '#/problem/' + r.code;
          return;
        }
        btn.disabled = false;
        btn.textContent = label;
        window.UI.toast('这些考点暂时没有未做的题了', 'ok');
      }).catch(function (e) {
        btn.disabled = false;
        btn.textContent = label;
        window.UI.toast(e.message, 'err');
      });
    });
  }

  Views.wrongbook = function (el) {
    if (!window.API.State.me) {
      el.innerHTML = '<div class="page-head"><div><h1>错题本</h1>'
        + '<p class="sub">登录后，没过 80 分线的题会自动收进来，可以按分数、按考点重刷。</p></div></div>'
        + '<div class="empty"><b>还没有错题本</b>登录后开始刷题，做错的题会自动记在这里。</div>';
      return;
    }

    el.innerHTML = '<div class="page-head"><div><h1>错题本</h1>'
      + '<p class="sub">没过 80 分线的题自动收录；重做通过后会自动移出。</p></div></div>'
      + '<div id="wrongWrap"><div class="loading-row"><span class="spinner"></span>加载中…</div></div>';

    Promise.all([
      window.API.get('/api/wrongbook'),
      window.API.get('/api/my/review-today').catch(function () { return { items: [], due: 0, total: 0 }; }),
      window.API.get('/api/my/stats').catch(function () { return null; })
    ]).then(function (arr) {
      const d = arr[0];
      const rv = arr[1];
      const stats = arr[2];
      const wrap = document.getElementById('wrongWrap');

      /* 按九主标签的通过率找薄弱项，一键挑一题来练 */
      const weakCard = function () {
        const weak = (stats && stats.weakMain) || [];
        if (!weak.length) return '';
        return '<div class="card" style="padding:14px 16px;margin-bottom:14px">'
          + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'
          + '<b>薄弱考点</b>'
          + weak.map(function (t) {
            const row = (stats.mainTags || []).filter(function (x) { return x.tag === t; })[0] || {};
            return '<span class="tag gold">' + window.Md.esc(t)
              + (row.attempts ? ' · 通过率 ' + row.rate + '%' : '') + '</span>';
          }).join('')
          + '<button class="btn btn-primary btn-sm" id="weakDrill">按薄弱考点练一题</button>'
          + '</div>'
          + '<div class="small muted" style="margin-top:8px">只出这些考点里你还没做对的题，做完会刷新这里的统计。</div>'
          + '</div>';
      };
      const reviewCard = function () {
        const due = rv.due || 0;
        if (!d.items.length) return '';
        if (!due) {
          return '<div class="card review-card" style="padding:14px 16px;margin-bottom:14px">'
            + '<b>今日复习</b> <span class="small muted">今天没有到期的题，按间隔重复，明天再来。</span></div>';
        }
        return '<div class="card review-card" style="padding:14px 16px;margin-bottom:14px">'
          + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'
          + '<b>今日复习</b><span class="tag gold">' + due + ' 题到期</span>'
          + '<span class="small muted">答对间隔翻倍（1→2→4→8 天），答错重置为 1 天</span>'
          + '<a class="btn btn-primary btn-sm" href="#/problem/' + rv.items[0].code + '?review=1">开始复习</a>'
          + '</div>'
          + '<div class="tags" style="margin-top:10px">'
          + rv.items.map(function (x) {
            return '<a class="tag" href="#/problem/' + x.code + '?review=1" title="上次 ' + x.lastScore + ' 分">'
              + x.code + ' · ' + window.Md.esc(String(x.title).slice(0, 12)) + '</a>';
          }).join('')
          + '</div></div>';
      };
      if (!d.items.length) {
        wrap.innerHTML = weakCard() + reviewCard() + '<div class="empty"><b>错题本是空的</b>去题库刷几道，没过 80 分的会出现在这里。</div>';
        bindWeakDrill();
        return;
      }
      wrap.innerHTML = weakCard() + reviewCard() +
        '<div class="stat-strip" style="grid-template-columns:repeat(3,1fr)">'
        + '<div class="stat"><div class="k">错题数</div><div class="v">' + d.total + '<small>题</small></div></div>'
        + '<div class="stat"><div class="k">已补做通过</div><div class="v">' + d.items.filter(function (x) { return x.solved; }).length + '<small>题</small></div></div>'
        + '<div class="stat"><div class="k">平均得分</div><div class="v">'
        + (function () {
          const arr = d.items.filter(function (x) { return typeof x.myScore === 'number'; });
          if (!arr.length) return '—';
          return Math.round(arr.reduce(function (s, x) { return s + x.myScore; }, 0) / arr.length);
        })() + '<small>分</small></div></div></div>'
        + '<div class="ptable"><div class="ptable-head"><span>状态</span><span>编号</span><span>题目</span><span>我的分数</span><span>次数</span></div>'
        + d.items.map(function (x) {
          return '<div class="prow" style="cursor:default">'
            + '<span class="pstate">' + (x.solved ? '<span class="ok">✓</span>' : '<span class="none"></span>') + '</span>'
            + '<span class="pcode">' + x.code + '</span>'
            + '<div class="pmain"><div class="pexcerpt"><a href="#/problem/' + x.code + '">' + window.Md.inlineTex(x.excerpt) + '</a></div>'
            + '<div class="tags">' + x.tags.map(function (t) { return '<span class="tag">' + window.Md.esc(t) + '</span>'; }).join('')
            + '<span class="tag gold">难度 ' + x.difficulty + '</span></div></div>'
            + '<div class="pdiff"><span class="rate">' + (x.myScore === null ? '—' : x.myScore + ' 分') + '</span>'
            + '<span class="rate">最高 ' + (x.best === null ? '—' : x.best) + '</span></div>'
            + '<div class="pmeta">' + x.tries + ' 次'
            + (x.intervalDays ? '<br><span class="small muted">间隔 ' + x.intervalDays + ' 天</span>' : '')
            + '</div>'
            + '</div>';
        }).join('')
        + '</div>';
      window.Md.renderMath(wrap);
      bindWeakDrill();
    }).catch(function (e) {
      document.getElementById('wrongWrap').innerHTML = window.UI.empty('加载失败', e.message);
    });
  };
})();
