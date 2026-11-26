/* 每日一积：每天一道较难的积分题 */
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
    /* 物理模式是「每日一物」：同一套视图，文案与取题接口按学科切换 */
    const isPhys = St.subject === 'physics';
    const TITLE = isPhys ? '每日一物' : '每日一积';

    Promise.all([
      window.API.get(St.withSubject('/api/daily')),
      window.API.get('/api/leaderboard').catch(function () { return { items: [] }; })
    ]).then(function (arr) {
      const data = arr[0];
      const board = arr[1];
      const p = data.problem;

      if (!p) {
        el.innerHTML = '<div class="page-head"><div><h1>' + TITLE + '</h1></div></div>'
          + window.UI.empty('题库还是空的', '等第一批题目审核入库后，这里每天会固定推一道。');
        return;
      }

      const lv = window.UI.levelOf(p.difficulty);

    /* 管理员：从「较难的积分题」池子里直接换今天的题 */
    function bindDailyPick() {
      const btn = document.getElementById('dailyPick');
      if (!btn) return;
      btn.addEventListener('click', async function () {
        const el = document.createElement('div');
        el.innerHTML = '<div class="small muted" style="margin-bottom:8px">候选池：难度 ≥ 6 的积分题（最多列 300 道）。</div>'
          + '<div class="field"><input id="dpFilter" placeholder="按题号或标题筛选" /></div>'
          + '<div id="dpList" style="max-height:320px;overflow:auto">加载中…</div>'
          + '<div class="small muted" style="margin-top:10px">今天：' + data.date + '　'
          + '<a href="#" id="dpClear">恢复自动选择</a></div>';
        window.UI.modal({ title: '换今天的每日一积', sub: '选中后立即生效', body: el, wide: true });
        const list = el.querySelector('#dpList');
        const d = await window.API.get('/api/admin/daily/pool');
        const render = function (kw) {
          const items = (d.items || []).filter(function (x) {
            return !kw || x.code.toLowerCase().includes(kw) || String(x.title).includes(kw);
          }).slice(0, 60);
          list.innerHTML = items.map(function (x) {
            return '<div class="related-item" data-code="' + x.code + '" style="cursor:pointer">'
              + '<span class="code">' + x.code + '</span>'
              + '<span class="t">' + window.Md.inlineTex(x.title) + '</span>'
              + '<span class="tag">难度 ' + x.difficulty + '</span></div>';
          }).join('') || '<div class="small muted">没有匹配的题</div>';
          list.querySelectorAll('[data-code]').forEach(function (row) {
            row.addEventListener('click', async function () {
              try {
                await window.API.post('/api/admin/daily', { date: data.date, code: row.dataset.code });
                window.UI.toast('已换成 ' + row.dataset.code, 'ok');
                window.location.hash = '#/daily';
                window.dispatchEvent(new HashChangeEvent('hashchange'));
              } catch (e) { window.UI.toast(e.message, 'err'); }
            });
          });
        };
        render('');
        el.querySelector('#dpFilter').addEventListener('input', function (e) { render(e.target.value.trim()); });
        el.querySelector('#dpClear').addEventListener('click', async function (e) {
          e.preventDefault();
          await window.API.post('/api/admin/daily', { date: data.date, clear: true });
          window.UI.toast('已恢复自动选择', 'ok');
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        });
      });
    }

      el.innerHTML =
        '<div class="page-head"><div><h1>' + TITLE + '</h1>'
        + '<p class="sub">每天一道较难的积分题，全站同步，按日期滚动；管理员可以换成自己选的题。</p></div>'
        + '<div class="head-actions">'
        + (window.API.State.me && window.API.State.me.role === 'admin'
          ? '<button class="btn" id="dailyPick">换今天的题</button>' : '')
        + '<a class="btn" href="#/problems">全部题库</a></div></div>'

        + '<div class="card daily-hero">'
        + '<div class="daily-date"><span class="d">' + data.date + '</span><span class="w">' + weekdayOf(data.date) + ' · 今日题</span></div>'
        + '<h1 id="dailyTitle"></h1>'
        + '<div class="daily-sub" id="dailyAlias"></div>'
        + '<div class="tags" style="margin-bottom:6px">' + window.UI.tagBadges(p)
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
        + '<div class="card side-card"><h3>经验榜 <span class="small muted">共 ' + (board.total || board.items.length) + ' 人</span></h3>'
        + (board.items.length
          ? '<div class="leader-list">' + board.items.map(function (u) {
            return '<div class="kv" style="align-items:center">'
              + '<span style="display:flex;align-items:center;gap:8px;min-width:0">'
              + '<b style="width:18px;color:' + (u.rank <= 3 ? 'var(--orange)' : 'var(--muted)') + '">' + u.rank + '</b>'
              + window.UI.avatar(u.name) + '<span style="color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + window.Md.esc(u.name) + '</span></span>'
              + '<span style="display:flex;align-items:center;gap:10px">'
              + '<span class="small muted">' + u.solvedCount + ' 题</span>'
              + '<b>' + u.exp + '</b></span></div>';
          }).join('') + '</div>'
          : '<div class="small muted">还没有人留下记录，你可以是第一个。</div>')
        + '</div>'
        + '<div class="card side-card"><h3>经验怎么算</h3><div class="xp-rule">'
        + '独立做出：按三维评分给经验<br/>看过答案：<b>−40%</b>　问过 AI：再 <b>−20%</b><br/>同一题只计一次</div></div>'
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
      bindDailyPick();
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
