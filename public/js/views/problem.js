/* 题目详情 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};
  const St = window.API.State;

  function hintBlock(hints, title) {
    const tip = title ? '<div class="hint-title">思路提示：' + window.Md.esc(title) + '</div>' : '';
    if (!hints || !hints.length) {
      return '<div class="hints"><h4>提示</h4>' + tip + '</div>';
    }
    return '<div class="hints"><h4>分层提示（点一次开一层）</h4>' + tip + '<ol id="hintList">'
      + hints.map(function (h, i) {
        return '<li data-i="' + i + '" style="display:' + (i === 0 ? 'list-item' : 'none') + '">' + window.Md.inlineTex(h) + '</li>';
      }).join('')
      + '</ol><button class="btn btn-sm btn-ghost" id="nextHint" style="margin-top:8px">'
      + (hints.length > 1 ? '再看一层提示' : '提示已全部展开') + '</button></div>';
  }


  /* 提交答案弹窗：文字或图片，交给 AI 判 */
  function openAnswerModal(p, rules, onPassed) {
    const el = document.createElement('div');
    el.innerHTML =
      '<div class="judge-tip">写下你的最终答案（LaTeX 或普通算式都行，如 <code>1/2</code>、<code>\\frac{1}{2}</code>），也可以传一张手写照片。不定积分记得带 <code>+C</code>。</div>'
      + '<div class="field"><label>答案</label><textarea id="ansText" rows="3" placeholder="例如：$x-\\ln(3e^{x}+1)+C$"></textarea></div>'
      + '<div class="field"><label>或者上传答案照片（可选）</label>'
      + '<input type="file" id="ansFile" accept="image/*" style="display:none" />'
      + '<div class="upload-row"><button type="button" class="btn btn-sm" id="pickImg">选择图片</button>'
      + '<span class="small muted" id="imgHint">图片判题需要支持视觉的模型（在对话「模型」里配置）</span></div>'
      + '<div id="imgPreview"></div></div>'
      + '<div class="judge-actions"><button class="btn btn-primary" id="judgeBtn">提交判题</button>'
      + '<span class="small muted">判对才计入经验，答错可以再交一次</span></div>'
      + '<div id="judgeResult"></div>';

    const m = window.UI.modal({ title: '提交答案 · ' + p.code, sub: '由 AI 判定正误，规则比对优先', body: el, wide: true });
    const resultBox = el.querySelector('#judgeResult');
    let image = '';

    el.querySelector('#pickImg').addEventListener('click', function () {
      el.querySelector('#ansFile').click();
    });

    el.querySelector('#ansFile').addEventListener('change', function (ev) {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function () {
        const img = new Image();
        img.onload = function () {
          const max = 1280;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const cv = document.createElement('canvas');
          cv.width = Math.round(img.width * scale);
          cv.height = Math.round(img.height * scale);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          image = cv.toDataURL('image/jpeg', 0.82);
          el.querySelector('#imgPreview').innerHTML = '<img src="' + image + '" class="judge-img" alt="答案预览" />';
          el.querySelector('#imgHint').textContent = '已选择图片，提交后会交给视觉模型';
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });

    el.querySelector('#judgeBtn').addEventListener('click', async function () {
      const btn = this;
      const answer = el.querySelector('#ansText').value.trim();
      if (!answer && !image) { window.UI.toast('写一下答案或传张图片', 'err'); return; }
      btn.disabled = true;
      btn.textContent = '判题中…';
      resultBox.innerHTML = '<div class="judge-result pending"><span class="spinner"></span>正在核对…（免费通道排队时可能十几秒）</div>';
      try {
        const res = await window.API.post('/api/problems/' + p.code + '/answer', {
          answer: answer,
          image: image || undefined,
          llm: window.Chat && window.Chat.llmConfig ? window.Chat.llmConfig() : undefined
        });
        renderJudge(res);
      } catch (e) {
        resultBox.innerHTML = '<div class="judge-result wrong">提交失败：' + window.Md.esc(e.message) + '</div>';
      } finally {
        btn.disabled = false;
        btn.textContent = '提交判题';
      }
    });

    function renderJudge(res) {
      const map = {
        correct: ['correct', '判定通过'],
        partial: ['partial', '部分正确'],
        wrong: ['wrong', '不正确'],
        unclear: ['unclear', '暂时判不了']
      };
      const meta = map[res.verdict] || map.unclear;
      let html = '<div class="judge-result ' + meta[0] + '"><b>' + meta[1] + '</b>'
        + (res.reason ? '<span>' + window.Md.esc(res.reason) + '</span>' : '')
        + (res.judgedBy ? '<span class="judged-by">判定来源：' + window.Md.esc(res.judgedBy) + '</span>' : '')
        + '</div>';
      if (res.verdict === 'correct') {
        if (res.already) {
          html += '<div class="judge-extra">这道题之前已经通过了。</div>';
        } else {
          html += '<div class="judge-extra">+' + res.gained + ' 经验 · 当前 Lv.' + res.level.level + '，总经验 ' + res.exp + '</div>';
          onPassed(res);
        }
      } else if (res.verdict === 'wrong' || res.verdict === 'partial') {
        html += '<div class="judge-extra">改一改再交一次；实在做不出来可以点「查看答案」，经验会打折。</div>';
      } else {
        html += '<div class="judge-extra">可以换个写法重交，或者点「查看答案」自己对照。</div>';
      }
      resultBox.innerHTML = html;
      if (res.verdict === 'correct') {
        setTimeout(function () { window.UI.toast('通过，+' + (res.gained || 0) + ' 经验', 'ok'); }, 200);
      }
    }
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
        + '  <div class="problem-head"><span class="problem-code-badge">' + p.code + '</span>' + window.UI.levelBadge(p) + '</div>'
        + '  <div class="meta-line">'
        + '    <span class="m">来源 <b>' + window.Md.esc(p.source || '未标注') + '</b></span>'
        + '    <span class="m">收录 <b>' + window.UI.fmtDate(p.createdAt) + '</b></span>'
        + '    <span class="m">通过 <b>' + p.solvedCount + '</b></span>'
        + '    <span class="m">尝试 <b>' + p.attemptCount + '</b></span>'
        + '  </div>'
        + '  <div class="statement" id="stmt"></div>'
        + '  <div class="score-panel">'
        + '    <div class="score-item"><div class="score-top"><span>思维量</span><b>' + p.thinking + '</b></div><div class="score-track"><div class="score-fill ' + (p.thinking >= 8 ? 'hi' : '') + '" style="width:' + p.thinking * 10 + '%"></div></div></div>'
        + '    <div class="score-item"><div class="score-top"><span>难度</span><b>' + p.difficulty + '</b></div><div class="score-track"><div class="score-fill ' + (p.difficulty >= 8 ? 'hi' : 'mid') + '" style="width:' + p.difficulty * 10 + '%"></div></div></div>'
        + '    <div class="score-item"><div class="score-top"><span>计算量</span><b>' + p.calc + '</b></div><div class="score-track"><div class="score-fill" style="width:' + p.calc * 10 + '%"></div></div></div>'
        + '    <div class="score-note"><span>三个维度均为 10 分制，由审题人标注</span><span>难度：' + window.UI.levelOf(p.difficulty).name + '</span></div>'
        + '  </div>'
        + '  <div class="actions" id="actionBar">'
        + '    <button class="btn btn-primary" id="solveBtn">' + (solved ? '已通过（+' + data.xpRules.base + ' 经验上限）' : '提交答案') + '</button>'
        + '    <button class="btn" id="hintBtn">' + window.UI.icon('spark') + ' 先给点提示</button>'
        + '    <button class="btn" id="answerBtn">查看答案</button>'
        + '    <button class="btn btn-ok" id="askBtn">' + window.UI.icon('spark') + ' 问 AI 助教</button>'
        + '  </div>'
        + '  <div id="answerSlot"></div>'
        + '</div>'
        + '<aside>'
        + '  <div class="card side-card"><h3>题目信息</h3>'
        + '    <div class="kv"><span>编号</span><b>' + p.code + '</b></div>'
        + '    <div class="kv" style="align-items:flex-start"><span>标题</span><b class="side-title">' + window.Md.inlineTex(p.title) + '</b></div>'
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

      // 题干直接作为正文主体，原标题放进提示区
      window.Md.render(document.getElementById('stmt'), p.statement);

      if (p.hintCount) {
        const hintSlot = document.createElement('div');
        document.getElementById('stmt').after(hintSlot);
        hintSlot.id = 'hintSlot';

        document.getElementById('hintBtn').addEventListener('click', function () {
          if (!hintSlot.innerHTML) {
            hintSlot.innerHTML = hintBlock(p.hints, p.title);
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

      /* 提交答案 → AI 判题 */
      const solveBtn = document.getElementById('solveBtn');
      solveBtn.disabled = solved;
      if (solved) solveBtn.classList.add('btn-ok');
      solveBtn.addEventListener('click', function () {
        if (!window.UI.requireLogin(null, '登录后才能提交答案')) return;
        openAnswerModal(p, data.xpRules, function (res) {
          solveBtn.textContent = '已通过（+' + res.gained + ' 经验）';
          solveBtn.disabled = true;
          solveBtn.classList.add('btn-ok');
          window.UI.applyUser(res.user);
        });
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
