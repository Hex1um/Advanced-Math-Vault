/* 每日一题 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};
  const St = window.API.State;

  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function weekdayOf(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return WEEK[d.getDay()] || '';
  }

  Views.daily = function (el) {
    el.innerHTML = '<div class="loading-row"><span class="spinner"></span>今天的好题正在出库…</div>';

    Promise.all([
      window.API.get('/api/daily'),
      window.API.get('/api/leaderboard').catch(function () { return { items: [] }; })
    ]).then(function (arr) {
      const data = arr[0];
      const board = arr[1];
      const p = data.problem;

      if (!p) {
        el.innerHTML = '<div class="page-head"><div><h1>每日一题</h1></div></div>'
          + window.UI.empty('题库还是空的', '等第一批题目审核入库后，这里每天会固定推一道。');
        return;
      }

      const lv = window.UI.levelOf(p.difficulty);

      el.innerHTML =
        '<div class="page-head"><div><h1>每日一题</h1>'
        + '<p class="sub">全站同一天看到的是同一道题，按日期滚动，不随刷新变化。</p></div>'
        + '<div class="head-actions"><a class="btn" href="#/problems">全部题库</a></div></div>'

        + '<div class="card daily-hero">'
        + '<div class="daily-date"><span class="d">' + data.date + '</span><span class="w">' + weekdayOf(data.date) + ' · 今日题</span></div>'
        + '<h1 id="dailyTitle"></h1>'
        + '<div class="daily-sub" id="dailyAlias"></div>'
        + '<div class="tags" style="margin-bottom:6px">' + p.tags.map(function (t) { return '<span class="tag">' + window.Md.esc(t) + '</span>'; }).join('')
        + '<span class="problem-code-badge" style="margin-left:4px">' + p.code + '</span>' + window.UI.levelBadge(p) + '</div>'
        + '<div class="statement" id="dailyStmt"></div>'
        + '<div class="score-panel" style="max-width:560px">'
        + scoreItem('思维量', p.thinking) + scoreItem('难度', p.difficulty) + scoreItem('计算量', p.calc)
        + '</div>'
        + '<div class="actions" style="border-top:0;padding-top:18px;margin-top:14px">'
        + '<a class="btn btn-primary" href="#/problem/' + p.code + '">' + (p.solved ? '再做一遍' : '开始做题') + '</a>'
        + '<button class="btn" id="dailyAnswer">看答案</button>'
        + '<button class="btn btn-ok" id="dailyAsk">' + window.UI.icon('spark') + ' 问 AI 助教</button>'
        + '</div></div>'

        + '<div class="daily-grid">'
        + '<div class="card side-card" style="margin:0;padding:18px 20px">'
        + '<h3>最近七日</h3>'
        + '<div class="week-grid">'
        + data.recent.slice().reverse().map(function (r) {
          const cls = (r.solved ? ' solved' : '') + (r.date === data.date ? ' today' : '');
          return '<a class="week-tile' + cls + '" href="#/problem/' + r.code + '" title="' + window.Md.esc(r.title) + '">'
            + '<span class="wd">' + r.date.slice(5) + '</span>'
            + '<span class="wt">' + window.Md.inlineTex(r.title) + '</span>'
            + '<span class="wfoot"><i class="wdot" style="background:' + r.levelColor + '"></i>'
            + (r.solved ? '已做' : r.date === data.date ? '今日' : '') + '</span></a>';
        }).join('')
        + '</div>'
        + '<div class="small muted" style="margin-top:12px">亮起来的日期表示你当天做掉了这题 · 每天 0 点换题，全站同一道</div>'
        + '</div>'

        + '<aside>'
        + '<div class="card side-card"><h3>经验榜</h3>'
        + (board.items.length
          ? board.items.slice(0, 6).map(function (u) {
            return '<div class="kv" style="align-items:center">'
              + '<span style="display:flex;align-items:center;gap:8px;min-width:0">'
              + '<b style="width:14px;color:' + (u.rank <= 3 ? '#ffd9a3' : 'var(--muted)') + '">' + u.rank + '</b>'
              + window.UI.avatar(u.name) + '<span style="color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + window.Md.esc(u.name) + '</span></span>'
              + '<b>' + u.exp + '</b></div>';
          }).join('')
          : '<div class="small muted">还没有人留下记录，你可以是第一个。</div>')
        + '</div>'
        + '<div class="card side-card"><h3>经验怎么算</h3><div class="xp-rule">'
        + '独立做出：按三维评分给经验<br/>看过答案：<b>×0.6</b>　问过 AI：再 <b>×0.8</b><br/>同一题只计一次</div></div>'
        + '</aside>'
        + '</div>';

      document.getElementById('dailyTitle').innerHTML = window.Md.inlineTex(p.excerpt || p.title);
      document.getElementById('dailyAlias').textContent = '思路提示：' + p.title;
      window.Md.render(document.getElementById('dailyStmt'), p.statement);

      document.getElementById('dailyAnswer').addEventListener('click', function () {
        location.hash = '#/problem/' + p.code;
        setTimeout(function () {
          const b = document.getElementById('answerBtn');
          if (b) b.click();
        }, 420);
      });
      document.getElementById('dailyAsk').addEventListener('click', function () {
        window.Chat.open({ problemCode: p.code, title: p.title, statement: p.statement });
      });
    }).catch(function (e) {
      el.innerHTML = window.UI.empty('加载失败', e.message);
    });

    function scoreItem(label, v) {
      const val = Math.max(1, Math.min(10, Number(v) || 5));
      return '<div class="score-item"><div class="score-top"><span>' + label + '</span><b>' + val + '</b></div>'
        + '<div class="score-track"><div class="score-fill ' + (val >= 8 ? 'hi' : '') + '" style="width:' + val * 10 + '%"></div></div></div>';
    }
  };
})();
