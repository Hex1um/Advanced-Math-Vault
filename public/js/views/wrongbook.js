/* 错题本：没过 80 分线的题都会在这里 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};

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

    window.API.get('/api/wrongbook').then(function (d) {
      const wrap = document.getElementById('wrongWrap');
      if (!d.items.length) {
        wrap.innerHTML = '<div class="empty"><b>错题本是空的</b>去题库刷几道，没过 80 分的会出现在这里。</div>';
        return;
      }
      wrap.innerHTML =
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
            + '<div class="pmeta">' + x.tries + ' 次</div>'
            + '</div>';
        }).join('')
        + '</div>';
      window.Md.renderMath(wrap);
    }).catch(function (e) {
      document.getElementById('wrongWrap').innerHTML = window.UI.empty('加载失败', e.message);
    });
  };
})();
