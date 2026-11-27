/* 错题本：手动收录的题在这里，按 FSRS 排复习（2026-11-27 起判错不再自动入本）
   - 逾期最久的排在最前；每行可以直接自评（忘了 / 吃力 / 良好 / 简单）
   - 自评会立刻把下次复习时间往后推，达到 8 天自动出本
   - 每行可写一句错因备注，只改备注不动排期 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};

  const RATINGS = [
    { key: 'again', label: '忘了', hint: '完全想不起来，明天再来' },
    { key: 'hard', label: '吃力', hint: '想起来了但很费劲' },
    { key: 'good', label: '良好', hint: '正常回忆起来' },
    { key: 'easy', label: '简单', hint: '一眼就会，隔久一点再复习' }
  ];

  function rateButtons(code) {
    // 结构统一由 Components 提供，错题本与试卷页共用同一套按钮
    if (window.Components) return window.Components.ratingBar(code);
    return '<span class="rate-btns" data-code="' + code + '">'
      + RATINGS.map(function (r) {
        return '<button class="chip" data-rate="' + r.key + '" data-code="' + code + '">' + r.label + '</button>';
      }).join('')
      + '</span>';
  }

  function stateLabel(x) {
    if (x.due) return x.overdueDays > 0 ? '逾期 ' + x.overdueDays + ' 天' : '今天到期';
    const days = Math.max(0, Math.ceil((x.nextReviewAt - Date.now()) / 864e5));
    return days > 0 ? days + ' 天后' : '今天到期';
  }

  function noteBox(x) {
    return '<div class="wrong-note" data-note-for="' + x.code + '">'
      + '<input class="control" data-noteinput="' + x.code + '" maxlength="200" placeholder="记一句错因（例如：换元后忘了回代）" value="' + window.Md.esc(x.note || '') + '" />'
      + '<button class="chip" data-savenote="' + x.code + '">保存</button>'
      + '</div>';
  }

  function bindWeakDrill() {
    const btn = document.getElementById('weakDrill');
    if (!btn) return;
    btn.addEventListener('click', function () {
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = '挑题中…';
      window.API.get(window.API.State.withSubject('/api/practice?focus=weak&mode=random')).then(function (r) {
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
        window.UI.toast(window.API.describe ? window.API.describe(e) : e.message, 'err');
      });
    });
  }

  /* 自评 / 备注：用事件委托绑定一次，重绘列表不用重新挂 */
  function bindRowActions(root, reload) {
    if (!root || root.__wrongBound) return;
    root.__wrongBound = true;
    root.addEventListener('click', function (ev) {
      const rateBtn = ev.target.closest && ev.target.closest('[data-rate]');
      if (rateBtn) {
        ev.preventDefault();
        const code = rateBtn.getAttribute('data-code');
        const rating = rateBtn.getAttribute('data-rate');
        const box = rateBtn.closest('.rate-btns');
        if (box) box.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
        window.API.post('/api/wrongbook/' + code + '/review', { rating: rating }).then(function (res) {
          window.UI.toast(res.graduated
            ? '这张卡已掌握，出本'
            : '下次复习：' + res.intervalDays + ' 天后（稳定度 ' + res.stability + '）', 'ok');
          reload();
        }).catch(function (e) {
          window.UI.toast(window.API.describe ? window.API.describe(e) : e.message, 'err');
          if (box) box.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
        });
        return;
      }

      const saveBtn = ev.target.closest && ev.target.closest('[data-savenote]');
      if (saveBtn) {
        ev.preventDefault();
        const code = saveBtn.getAttribute('data-savenote');
        const input = document.querySelector('[data-noteinput="' + code + '"]');
        const note = input ? input.value.trim() : '';
        saveBtn.disabled = true;
        window.API.post('/api/wrongbook/' + code + '/note', { note: note }).then(function () {
          window.UI.toast(note ? '备注已保存' : '备注已清空', 'ok');
        }).catch(function (e) {
          window.UI.toast(window.API.describe ? window.API.describe(e) : e.message, 'err');
        }).finally(function () {
          saveBtn.disabled = false;
        });
      }
    });
  }

  Views.wrongbook = function (el) {
    if (!window.API.State.me) {
      el.innerHTML = '<div class="page-head"><div><h1>错题本</h1>'
        + '<p class="sub">登录后，在题目页点「加入错题本」收进来，可以按分数、按考点重刷。</p></div></div>'
        + '<div class="empty"><b>还没有错题本</b>登录后进题目页，点「加入错题本」就会收进来。</div>';
      return;
    }

    el.innerHTML = '<div class="page-head"><div><h1>错题本</h1>'
      + '<p class="sub">手动收录（题目页点「加入错题本」）；按间隔重复排期，复习到间隔 8 天自动出本。</p></div>'
      + '<div class="head-actions"><button class="btn btn-sm" id="ankiExport" title="导出为 Anki 可导入的 TSV">导出到 Anki</button></div></div>'
      + '<div id="wrongWrap"><div class="loading-row"><span class="spinner"></span>加载中…</div></div>';

    let disposed = false;

    /* 一键导出 Anki：UTF-8 TSV，Delimiter 用制表符，卡片正面题干、背面提示+答案+解析。
       公式定界符换成 Anki 原生的 \(...\) / \[...\]，导入后手机端也能正常渲染。 */
    function toAnkiMath(text) {
      return String(text || '')
        .replace(/\$\$([\s\S]+?)\$\$/g, function (m, body) { return '\\[' + body.trim() + '\\]'; })
        .replace(/\$([^$\n]+?)\$/g, function (m, body) { return '\\(' + body.trim() + '\\)'; })
        .replace(/\r?\n/g, '<br>');
    }

    function exportAnki() {
      window.API.get(window.API.State.withSubject('/api/wrongbook')).then(function (d) {
        const items = (d.items || []);
        if (!items.length) { window.UI.toast('错题本是空的', 'err'); return; }
        const rows = [['Code', 'Title', 'Front', 'Back', 'Tags']];
        items.forEach(function (it) {
          const front = toAnkiMath(it.excerpt || it.title) ;
          const back = [it.note ? '错因：' + it.note : '', '答案与解析见原题：' + location.origin + '/#/problem/' + it.code].filter(Boolean).join('<br>');
          rows.push([it.code, it.title, front, back, (it.tags || []).join(' ')]);
        });
        const tsv = rows.map(function (r) {
          return r.map(function (c) { return String(c).replace(/\t/g, ' ').replace(/\n/g, ' '); }).join('\t');
        }).join('\n');
        const blob = new Blob(['\ufeff' + tsv], { type: 'text/tab-separated-values;charset=utf-8' });
        window.API.download(blob, 'math-vault-wrongbook-' + new Date().toISOString().slice(0, 10) + '.tsv');
      }).catch(function (e) {
        window.UI.toast(window.API.describe ? window.API.describe(e) : '导出失败', 'err');
      });
    }

    const ankiBtn = document.getElementById('ankiExport');
    if (ankiBtn) ankiBtn.addEventListener('click', exportAnki);

    function load() {
      const wrap = document.getElementById('wrongWrap');
      if (!wrap) return;
      Promise.all([
        window.API.get(window.API.State.withSubject('/api/wrongbook')),
        window.API.get('/api/my/review-today').catch(function () { return { items: [], due: 0, total: 0 }; }),
        window.API.get(window.API.State.withSubject('/api/my/stats')).catch(function () { return null; })
      ]).then(function (arr) {
        if (disposed) return;
        const d = arr[0];
        const rv = arr[1];
        const stats = arr[2];

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
            const next = d.items
              .filter(function (x) { return x.nextReviewAt; })
              .sort(function (a, b) { return a.nextReviewAt - b.nextReviewAt; })[0];
            return '<div class="card review-card" style="padding:14px 16px;margin-bottom:14px">'
              + '<b>今日复习</b> <span class="small muted">今天没有到期的题'
              + (next ? '，下一张 ' + stateLabel(next) + ' 到期' : '') + '。按间隔重复，明天再来。</span></div>';
          }
          return '<div class="card review-card" style="padding:14px 16px;margin-bottom:14px">'
            + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'
            + '<b>今日复习</b><span class="tag gold">' + due + ' 题到期</span>'
            + '<span class="small muted">复习完给自己评一次：忘了 / 吃力 / 良好 / 简单，间隔会按稳定度自动拉长</span>'
            + '<a class="btn btn-primary btn-sm" href="#/problem/' + rv.items[0].code + '?review=1">开始复习</a>'
            + '</div>'
            + '<div class="review-list">'
            + rv.items.map(function (x) {
              return '<div class="review-row">'
                + '<a class="tag" href="#/problem/' + x.code + '?review=1" title="上次 ' + x.lastScore + ' 分">'
                + x.code + ' · ' + window.Md.esc(String(x.title).slice(0, 14)) + '</a>'
                + '<span class="small muted">' + (x.overdueDays > 0 ? '逾期 ' + x.overdueDays + ' 天' : '今天') + '</span>'
                + rateButtons(x.code)
                + '</div>';
            }).join('')
            + '</div></div>';
        };

        if (!d.items.length) {
          wrap.innerHTML = weakCard() + reviewCard()
            + '<div class="empty"><b>错题本是空的</b>去题库打开一道题，点「加入错题本」就会出现在这里。</div>';
          bindWeakDrill();
          bindRowActions(wrap, load);
          return;
        }

        const avg = (function () {
          const list = d.items.filter(function (x) { return typeof x.myScore === 'number'; });
          if (!list.length) return '—';
          return Math.round(list.reduce(function (s, x) { return s + x.myScore; }, 0) / list.length);
        })();

        const strip = window.Components
          ? window.Components.statStrip([
            { k: '错题数', v: d.total, unit: '题' },
            { k: '今日到期', v: rv.due || 0, unit: '题' },
            { k: '已掌握出本', v: rv.archive || 0, unit: '题' },
            { k: '平均得分', v: avg, unit: '分' }
          ])
          : '';
        wrap.innerHTML = weakCard() + reviewCard() + strip
          + '<div class="ptable"><div class="ptable-head"><span>状态</span><span>编号</span><span>题目</span><span>我的分数</span><span>复习</span></div>'
          + d.items.map(function (x) {
            return '<div class="prow" style="cursor:default">'
              + '<span class="pstate">' + (x.solved ? '<span class="ok">✓</span>' : '<span class="none"></span>') + '</span>'
              + '<span class="pcode">' + x.code + '</span>'
              + '<div class="pmain"><div class="pexcerpt"><a href="#/problem/' + x.code + '">' + window.Md.inlineTex(x.excerpt) + '</a></div>'
              + '<div class="tags">' + (x.tags || []).map(function (t) { return '<span class="tag">' + window.Md.esc(t) + '</span>'; }).join('')
              + '<span class="tag gold">难度 ' + x.difficulty + '</span>'
              + '<span class="tag">' + (x.state === 'relearning' ? '重学中' : x.state === 'learning' ? '学习中' : x.state === 'review' ? '复习中' : '新错题') + '</span></div>'
              + noteBox(x)
              + '</div>'
              + '<div class="pdiff"><span class="rate">' + (x.myScore === null ? '—' : x.myScore + ' 分') + '</span>'
              + '<span class="rate">最高 ' + (x.best === null ? '—' : x.best) + '</span>'
              + '<span class="rate small">' + x.tries + ' 次 · 稳定度 ' + (x.stability || 0) + ' 天</span></div>'
              + '<div class="pmeta">'
              + '<span class="' + (x.due ? 'tag gold' : 'small muted') + '">' + stateLabel(x) + '</span>'
              + '<div class="small muted" style="margin-top:4px">间隔 ' + x.intervalDays + ' 天</div>'
              + (x.due ? rateButtons(x.code) : '<a class="chip" href="#/problem/' + x.code + '">去复习</a>')
              + '</div>'
              + '</div>';
          }).join('')
          + '</div>';

        window.Md.renderMath(wrap);
        bindWeakDrill();
        bindRowActions(wrap, load);
      }).catch(function (e) {
        if (disposed) return;
        const wrap = document.getElementById('wrongWrap');
        if (wrap) wrap.innerHTML = window.UI.empty('加载失败', window.API.describe ? window.API.describe(e) : e.message);
      });
    }

    load();

    return function cleanup() {
      disposed = true;
    };
  };
})();
