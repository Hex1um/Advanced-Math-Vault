/* 题目详情 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};
  const St = window.API.State;

  function hintBlock(hints) {
    if (!hints || !hints.length) return '';
    return '<div class="hints"><h4>分层提示（点一次开一层）</h4><ol id="hintList">'
      + hints.map(function (h, i) {
        return '<li data-i="' + i + '" style="display:' + (i === 0 ? 'list-item' : 'none') + '">' + window.Md.inlineTex(h) + '</li>';
      }).join('')
      + '</ol><button class="btn btn-sm btn-ghost" id="nextHint" style="margin-top:8px">'
      + (hints.length > 1 ? '再看一层提示' : '提示已全部展开') + '</button></div>';
  }

  Views.problem = function (el, params) {
    const code = String(params.code || '').toUpperCase();
    el.innerHTML = '<div class="loading-row"><span class="spinner"></span>正在打开题目 ' + window.Md.esc(code) + '…</div>';

    window.API.get('/api/problems/' + code).then(function (data) {
      const p = data.problem;
      const solved = !!(p.mySolve && p.mySolve.done);
      const revealed = !!(p.mySolve && p.mySolve.revealed);

      el.innerHTML =
        '<div class="crumbs"><a href="#/problems">题库</a><span class="sep">/</span><span class="mono">' + p.code + '</span></div>'
        + '<div class="detail-grid">'
        + '<div class="card problem-main">'
        + '  <div class="problem-head"><h1 id="pTitle"></h1><span class="problem-code-badge">' + p.code + '</span></div>'
        + '  <div class="meta-line">'
        + '    <span class="m">来源 <b>' + window.Md.esc(p.source || '未标注') + '</b></span>'
        + '    <span class="m">收录 <b>' + window.UI.fmtDate(p.createdAt) + '</b></span>'
        + '    <span class="m">通过 <b>' + p.solvedCount + '</b></span>'
        + '    <span class="m">尝试 <b>' + p.attemptCount + '</b></span>'
        + '    <span class="m">' + window.UI.levelBadge(p) + '</span>'
        + '  </div>'
        + '  <div class="statement" id="stmt"></div>'
        + '  <div class="score-panel">'
        + '    <div class="score-item"><div class="score-top"><span>思维量</span><b>' + p.thinking + '</b></div><div class="score-track"><div class="score-fill ' + (p.thinking >= 8 ? 'hi' : '') + '" style="width:' + p.thinking * 10 + '%"></div></div></div>'
        + '    <div class="score-item"><div class="score-top"><span>难度</span><b>' + p.difficulty + '</b></div><div class="score-track"><div class="score-fill ' + (p.difficulty >= 8 ? 'hi' : 'mid') + '" style="width:' + p.difficulty * 10 + '%"></div></div></div>'
        + '    <div class="score-item"><div class="score-top"><span>计算量</span><b>' + p.calc + '</b></div><div class="score-track"><div class="score-fill" style="width:' + p.calc * 10 + '%"></div></div></div>'
        + '    <div class="score-note"><span>三个维度均为 10 分制，由审题人标注</span><span>难度：' + window.UI.levelOf(p.difficulty).name + '</span></div>'
        + '  </div>'
        + '  <div class="actions" id="actionBar">'
        + '    <button class="btn btn-primary" id="solveBtn">' + (solved ? '已做出（+' + (p.mySolve.xpGain || data.xpRules.base) + ' 经验）' : '我做出这道题了') + '</button>'
        + '    <button class="btn" id="hintBtn">' + window.UI.icon('spark') + ' 先给点提示</button>'
        + '    <button class="btn" id="answerBtn">查看答案</button>'
        + '    <button class="btn btn-ok" id="askBtn">' + window.UI.icon('spark') + ' 问 AI 助教</button>'
        + '  </div>'
        + '  <div id="answerSlot"></div>'
        + '</div>'
        + '<aside>'
        + '  <div class="card side-card"><h3>题目信息</h3>'
        + '    <div class="kv"><span>编号</span><b>' + p.code + '</b></div>'
        + '    <div class="kv"><span>难度评级</span><b style="color:' + window.UI.levelOf(p.difficulty).color + '">' + window.UI.levelOf(p.difficulty).name + '</b></div>'
        + '    <div class="kv"><span>供稿</span><b>' + window.Md.esc(p.authorName || '题库组') + '</b></div>'
        + '    <div class="kv"><span>提示数</span><b>' + p.hintCount + '</b></div>'
        + '    <div style="margin-top:10px" class="tags">' + p.tags.map(function (t) { return '<span class="tag">' + window.Md.esc(t) + '</span>'; }).join('') + '</div>'
        + '  </div>'
        + '  <div class="card side-card"><h3>经验规则</h3>'
        + '    <div class="xp-rule">独立做出：<b>+' + data.xpRules.base + '</b> 经验<br/>'
        + '      看过答案：经验 <b>×0.6</b><br/>'
        + '      问过 AI：再 <b>×0.8</b><br/>'
        + '      <span class="muted">每题只计一次，自动化计算不重复给分。</span></div>'
        + '  </div>'
        + (data.related && data.related.length
          ? '  <div class="card side-card"><h3>同考点题目</h3>'
          + data.related.map(function (r) {
            return '<a class="related-item" href="#/problem/' + r.code + '"><span class="code">' + r.code + '</span>'
              + '<span class="t">' + window.Md.inlineTex(r.title) + '</span>'
              + '<span style="width:6px;height:6px;border-radius:50%;background:' + r.levelColor + '"></span></a>';
          }).join('')
          + '</div>'
          : '')
        + '</aside>'
        + '</div>';

      document.getElementById('pTitle').innerHTML = window.Md.inlineTex(p.title);
      window.Md.render(document.getElementById('stmt'), p.statement);

      if (p.hintCount) {
        const hintSlot = document.createElement('div');
        document.getElementById('stmt').after(hintSlot);
        hintSlot.id = 'hintSlot';

        document.getElementById('hintBtn').addEventListener('click', function () {
          if (!hintSlot.innerHTML) {
            hintSlot.innerHTML = hintBlock(p.hints);
            window.Md.renderMath(hintSlot);
            const next = hintSlot.querySelector('#nextHint');
            let shown = 1;
            next.addEventListener('click', function () {
              const items = hintSlot.querySelectorAll('#hintList li');
              if (shown < items.length) {
                items[shown].style.display = 'list-item';
                shown++;
                if (shown >= items.length) { next.textContent = '提示已全部展开'; next.disabled = true; }
              }
            });
            if (p.hints.length <= 1) { next.disabled = true; }
          } else {
            hintSlot.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        });
      } else {
        document.getElementById('hintBtn').disabled = true;
      }

      /* 标记完成 */
      const solveBtn = document.getElementById('solveBtn');
      solveBtn.disabled = solved;
      solveBtn.addEventListener('click', async function () {
        if (!window.UI.requireLogin(null, '登录后才会记录经验和进度')) return;
        solveBtn.disabled = true;
        const beforeLevel = St.me ? St.me.level : 1;
        try {
          const res = await window.API.post('/api/problems/' + code + '/solve');
          if (res.already) {
            window.UI.toast('这道题之前已经计过经验了');
          } else {
            solveBtn.textContent = '已做出（+' + res.gained + ' 经验）';
            solveBtn.classList.add('btn-ok');
            const afterLevel = res.level.level;
            window.UI.applyUser(res.user);
            if (afterLevel > beforeLevel) {
              window.UI.toast('升级！现在是 Lv.' + afterLevel, 'ok');
            } else {
              window.UI.toast('+' + res.gained + ' 经验 · 总经验 ' + res.exp, 'ok');
            }
            const row = document.querySelector('.prow[data-code="' + code + '"]');
            if (row) row.classList.add('solved');
          }
        } catch (e) {
          window.UI.toast(e.message, 'err');
          solveBtn.disabled = false;
        }
      });

      /* 查看答案 */
      const answerSlot = document.getElementById('answerSlot');
      document.getElementById('answerBtn').addEventListener('click', async function () {
        const btn = this;
        btn.disabled = true;
        try {
          const res = await window.API.post('/api/problems/' + code + '/reveal');
          const box = document.createElement('div');
          box.className = 'answer-box';
          box.innerHTML =
            '<div class="answer-head"><b>参考答案与解析</b>'
            + '<span class="small muted right">看答案后经验 ×0.6</span></div>'
            + '<div class="answer-body"><div class="md" id="ansBody"></div></div>';
          answerSlot.innerHTML = '';
          answerSlot.appendChild(box);
          const body = box.querySelector('#ansBody');
          const parts = [];
          if (res.answer) parts.push('**答案**：' + res.answer);
          if (res.solution) parts.push(res.solution);
          window.Md.render(body, parts.join('\n\n') || '这道题暂时没有录入解析，可以点「问 AI 助教」。');
          window.Md.renderMath(body);
          btn.textContent = '答案已展开';
          box.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (e) {
          window.UI.toast(e.message, 'err');
          btn.disabled = false;
        }
      });

      /* AI 问答 */
      document.getElementById('askBtn').addEventListener('click', function () {
        window.Chat.open({ problemCode: code, title: p.title, statement: p.statement });
      });

      // 支持 #/problem/HS1001?ask=1 直接进入答疑（可带 q= 预置问题）
      if (String(params.ask || '') === '1') {
        const q = params.q ? String(params.q) : '';
        setTimeout(function () {
          window.Chat.open({ problemCode: code, title: p.title, statement: p.statement, autoAsk: q || undefined });
        }, 200);
      }
    }).catch(function (e) {
      el.innerHTML = '<div class="empty"><b>题目打不开</b>' + window.Md.esc(e.message)
        + '<div style="margin-top:14px"><a class="btn btn-sm" href="#/problems">返回题库</a></div></div>';
    });
  };
})();
