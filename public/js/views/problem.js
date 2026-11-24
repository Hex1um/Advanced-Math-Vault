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


  /* 提交解题过程：AI 逐步核对，指出出错的位置 */
  function openAnswerModal(p, rules, onPassed) {
    const el = document.createElement('div');
    el.innerHTML =
      '<div class="judge-problem">'
      + '<div class="jp-head"><span class="code">' + p.code + '</span>'
      + '<span class="t" id="jpTitle"></span></div>'
      + '<div class="jp-body md" id="jpStmt"></div>'
      + '<button type="button" class="jp-fold" id="jpFold">收起题目</button>'
      + '</div>'
      + '<div class="judge-tip">AI 按 <b>0-100</b> 打分并指出错在哪一步。'
      + '<b>思路 + 正确答案</b>给 90 分；<b>只交正确答案</b>给 80 分；'
      + '<b>出错会大幅扣分</b>（错一步就掉到 50 分以下）。</div>'
      + '<div class="seg" id="modeSeg" style="margin-bottom:12px">'
      + '<button type="button" data-mode="process" class="active">写思路 + 答案</button>'
      + '<button type="button" data-mode="answer">只交答案</button></div>'
      + '<div id="historyBox"></div>'
      + '<div class="field"><label>解题过程</label>'
      + '<textarea id="ansProcess" rows="8" placeholder="例如：&#10;1. 令 t=√x，则 x=t²，dx=2t dt&#10;2. 原式 = 2∫t e^t dt&#10;3. 分部积分 = 2(t-1)e^t + C&#10;4. 回代得 2(√x-1)e^{√x}+C"></textarea>'
      + '<div class="tip">公式可以直接写 LaTeX（如 <code>\\frac{1}{2}</code>）或普通写法（如 <code>1/2</code>、<code>sqrt(x)</code>）。</div></div>'
      + '<div class="field"><label>或者上传过程照片（可选）</label>'
      + '<input type="file" id="ansFile" accept="image/*" style="display:none" />'
      + '<div class="upload-row"><button type="button" class="btn btn-sm" id="pickImg">选择图片</button>'
      + '<span class="small muted" id="imgHint">读图片需要支持视觉的模型（在右上「设置」里配置）</span></div>'
      + '<div id="imgPreview"></div></div>'
      + '<div class="judge-actions"><button class="btn btn-primary" id="judgeBtn">提交批改</button>'
      + '<span class="small muted">答错可以改完再交，不限次数</span></div>'
      + '<div id="judgeResult"></div>';

    const m = window.UI.modal({ title: '提交解题过程 · ' + p.code, sub: '由 AI 逐步核对并指出错误位置', body: el, wide: true });
    if (window.MathKey) window.MathKey.attachAll(el);

    /* 弹窗里回显题干，做题时不用来回切页面 */
    const jpTitle = el.querySelector('#jpTitle');
    const jpStmt = el.querySelector('#jpStmt');
    if (jpTitle) jpTitle.innerHTML = window.Md.inlineTex(p.title || p.code);
    if (jpStmt) window.Md.render(jpStmt, p.statement || '');
    const jpFold = el.querySelector('#jpFold');
    if (jpFold) {
      jpFold.addEventListener('click', function () {
        const hidden = jpStmt.style.display === 'none';
        jpStmt.style.display = hidden ? '' : 'none';
        jpFold.textContent = hidden ? '收起题目' : '展开题目';
      });
    }
    const resultBox = el.querySelector('#judgeResult');
    let image = '';
    let mode = 'process';

    window.API.get('/api/problems/' + p.code + '/history').then(function (h) {
      const box = el.querySelector('#historyBox');
      if (!box || !h.items || !h.items.length) return;
      box.innerHTML = '<details class="history-box"><summary>你之前交过 ' + h.items.length + ' 次'
        + (h.best ? '（最高 ' + h.best + ' 分）' : '') + '，点开看记录</summary>'
        + h.items.map(function (it) {
          return '<div class="hist-item"><div class="hist-top"><span>' + window.UI.fmtDate(it.at) + '</span>'
            + '<span class="tag">' + it.score + ' 分</span>'
            + '<span class="small muted">' + (it.mode === 'answer' ? '只交答案' : '思路+答案') + '</span></div>'
            + (it.comment ? '<div class="hist-comment md">' + window.Md.inlineTex(String(it.comment).slice(0, 120)) + '</div>' : '')
            + (it.process ? '<div class="hist-proc">' + window.Md.esc(String(it.process).slice(0, 140)) + '</div>' : '')
            + '</div>';
        }).join('') + '</details>';
      window.Md.renderMath(box);
    }).catch(function () {});

    el.querySelectorAll('#modeSeg [data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        mode = b.dataset.mode;
        el.querySelectorAll('#modeSeg [data-mode]').forEach(function (x) { x.classList.toggle('active', x === b); });
        const ta = el.querySelector('#ansProcess');
        ta.rows = mode === 'answer' ? 2 : 8;
        ta.placeholder = mode === 'answer'
          ? '只写最终答案，比如 $x-\\ln(3e^{x}+1)+C$（答对得 80 分）'
          : '写清每一步和依据：换元、分部积分、回代…';
        el.querySelector('#judgeBtn').textContent = mode === 'answer' ? '提交答案评分' : '提交批改';
      });
    });

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
          const max = 1400;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const cv = document.createElement('canvas');
          cv.width = Math.round(img.width * scale);
          cv.height = Math.round(img.height * scale);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          image = cv.toDataURL('image/jpeg', 0.85);
          el.querySelector('#imgPreview').innerHTML = '<img src="' + image + '" class="judge-img" alt="过程预览" />';
          el.querySelector('#imgHint').textContent = window.OCR && window.OCR.hasVisionModel()
            ? '已选择图片，提交后交给视觉模型批改'
            : '已选择图片，提交时先用 OCR 转成文字，再交给 AI 批改（公式建议手动核对）';
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });

    el.querySelector('#judgeBtn').addEventListener('click', async function () {
      const btn = this;
      let process = el.querySelector('#ansProcess').value.trim();
      const answerOnly = mode === 'answer';
      if (!process && !image) { window.UI.toast(answerOnly ? '写下答案' : '把解题过程写下来，或者传张照片', 'err'); return; }
      if (!answerOnly && process && process.length < 20) { window.UI.toast('过程太短了，写清关键几步（至少 20 字）', 'err'); return; }

      // 图片 + 没有视觉模型：先在浏览器里 OCR，把识别文字作为过程交给 AI
      const hasVision = window.OCR ? window.OCR.hasVisionModel() : false;
      let sendImage = image;
      if (image && !hasVision) {
        btn.disabled = true;
        btn.textContent = '识别图片中…';
        resultBox.innerHTML = '<div class="judge-result pending"><span class="spinner"></span>没有视觉模型，先用 OCR 把图片转成文字（首次需下载识别组件）…</div>';
        try {
          let text = window.OCR.tidy(await window.OCR.imageToText(image, function (pct) {
            btn.textContent = '识别中 ' + pct + '%';
          }));
          if (!text) throw new Error('图片里没识别到文字，请改用文字输入或配置视觉模型');
          // OCR 只认字形，公式结构要靠 AI 补回来
          btn.textContent = '规范化公式…';
          try {
            text = await window.OCR.polishWithAI(text, { problem: p.title, llm: window.UI.llmConfig() });
          } catch (e2) { /* 规范化失败就用原始识别结果 */ }
          process = process ? (process + '\n\n【图片识别】\n' + text) : text;
          el.querySelector('#ansProcess').value = process;
          el.querySelector('#imgHint').textContent = '已 OCR 并规范化（公式请再核对一遍）；下面文字会交给 AI 批改';
          sendImage = ''; // 识别成了文字，不再把图片发给不支持视觉的模型
          window.UI.toast('OCR 完成，请核对公式后提交', 'ok');
        } catch (e) {
          resultBox.innerHTML = '<div class="judge-result wrong">OCR 失败：' + window.Md.esc(e.message)
            + '<br/>可以配置支持视觉的模型（gpt-4o / qwen-vl 等），或把过程手打成文字。</div>';
          btn.disabled = false;
          btn.textContent = '提交批改';
          return;
        }
      }

      if (!answerOnly && process && process.length < 20) { window.UI.toast('识别出的文字太短，请补充过程', 'err'); btn.disabled = false; btn.textContent = '提交批改'; return; }
      btn.disabled = true;
      btn.textContent = '批改中…';
      resultBox.innerHTML = '<div class="judge-result pending"><span class="spinner"></span>正在逐步核对…（免费通道排队时可能要十几秒）</div>';
      try {
        const res = await window.API.post('/api/problems/' + p.code + '/answer', {
          process: process,
          answer: answerOnly ? process : undefined,
          mode: answerOnly ? 'answer' : 'process',
          image: sendImage || undefined,
          llm: window.UI.llmConfig()
        });
        renderJudge(res);
      } catch (e) {
        resultBox.innerHTML = '<div class="judge-result wrong">提交失败：' + window.Md.esc(e.message) + '</div>';
      } finally {
        btn.disabled = false;
        btn.textContent = '提交批改';
      }
    });

    function renderJudge(res) {
      const map = {
        correct: ['correct', '通过'],
        partial: ['partial', '部分正确'],
        wrong: ['wrong', '不正确'],
        unclear: ['unclear', '暂时判不了']
      };
      const meta = map[res.verdict] || map.unclear;
      const scoreTxt = typeof res.score === 'number' ? res.score + ' / 100' : '';
      let html = '<div class="judge-result ' + (res.passed ? 'correct' : meta[0]) + '"><b>' + (res.passed ? '通过' : meta[1]) + '</b>'
        + (scoreTxt ? '<span class="judge-score">' + scoreTxt + '</span>' : '')
        + (res.verdict !== 'unclear' ? '<span class="small muted">通过线 ' + (res.passLine || 80) + '</span>' : '')
        + (res.judgedBy ? '<span class="judged-by">阅卷：' + window.Md.esc(res.judgedBy) + '</span>' : '')
        + '</div>';

      if (res.comment) html += '<div class="judge-comment md">' + window.Md.inlineTex(res.comment) + '</div>';

      if (Array.isArray(res.errors) && res.errors.length) {
        html += '<div class="judge-errors"><div class="je-head">问题在这儿</div><ol>'
          + res.errors.map(function (x) { return '<li>' + window.Md.inlineTex(String(x)) + '</li>'; }).join('')
          + '</ol></div>';
      } else if (res.passed) {
        html += '<div class="judge-extra">过程没挑出问题。</div>';
      }

      const bits = [];
      if (res.attempt) bits.push('第 ' + res.attempt + ' 次提交');
      if (res.isBest) bits.push('刷新了你的最高分');
      if (typeof res.myBest === 'number') bits.push('我的最高 ' + res.myBest);
      if (typeof res.avgScore === 'number') bits.push('全站平均 ' + res.avgScore);
      if (bits.length) html += '<div class="judge-extra">' + bits.join(' · ') + '</div>';

      if (res.passed) {
        if (res.already) html += '<div class="judge-extra">这道题之前已经通过了。</div>';
        else {
          html += '<div class="judge-extra">+' + res.gained + ' 经验 · 当前 Lv.' + res.level.level + '，总经验 ' + res.exp + '</div>';
          onPassed(res);
        }
      } else if (res.verdict === 'partial' || res.verdict === 'wrong') {
        html += '<div class="judge-extra">' + (typeof res.score === 'number' && res.score < 80 ? '差一点就到 80 了，改完再交一次。' : '') + '这题已进错题本。</div>';
      } else {
        html += '<div class="judge-extra">可以再交一次，或者点「查看答案」自己对照。</div>';
      }

      resultBox.innerHTML = html;
      window.Md.renderMath(resultBox);
      if (res.passed && !res.already) {
        setTimeout(function () { window.UI.toast('通过，' + res.score + ' 分，+' + (res.gained || 0) + ' 经验', 'ok'); }, 200);
      }
    }
  }

  /* 每道题自己的讨论区：发帖可带图，AI 会自动回一条 */
  /* 题目反馈：先经 AI 审阅，再转管理员 */
  function openFeedbackModal(p) {
    if (!window.UI.requireLogin(null, '登录后才能提交题目反馈')) return;
    const el = document.createElement('div');
    const types = [
      ['wrong_answer', '答案/解析有误'], ['wrong_statement', '题干有误'],
      ['score', '评分不合理'], ['tags', '标签不准确'], ['other', '其他问题']
    ];
    el.innerHTML =
      '<p class="small muted" style="margin:0 0 12px">反馈会先由 AI 审阅归类，再转交管理员。请写清具体是哪一步、哪一处有问题。</p>'
      + '<div class="field"><label>反馈类型</label><select id="fbType">'
      + types.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('')
      + '</select></div>'
      + '<div class="field"><label>反馈内容（至少 6 字）</label><textarea id="fbContent" rows="6" placeholder="例如：解析第二步把 $\\sqrt{x^2+1}$ 写成了 $x+1$，这里应该有条件限制……"></textarea></div>'
      + '<div class="field"><label>附图中说明（选填，直接传图请使用答疑区）</label><input id="fbImageDesc" placeholder="例如：截图第 3 行公式与题库不一致" maxlength="200" /></div>'
      + '<div id="fbMsg" class="form-error"></div>'
      + '<div style="display:flex;gap:10px;margin-top:12px"><button class="btn btn-primary" id="fbSend">提交反馈</button>'
      + '<button class="btn" id="fbMine">查看我的反馈</button></div>'
      + '<div id="fbMineList" style="margin-top:14px"></div>';
    const m = window.UI.modal({ title: '反馈题目 · ' + p.code, sub: 'AI 先审阅，再转管理员', body: el, wide: true });
    if (window.MathKey) window.MathKey.attachAll(el);

    function loadMine() {
      window.API.get('/api/problems/' + p.code + '/feedback').then(function (d) {
        const box = el.querySelector('#fbMineList');
        if (!d.items.length) { box.innerHTML = '<div class="small muted">你还没有反馈过这道题。</div>'; return; }
        box.innerHTML = '<div class="small muted" style="margin-bottom:6px">我的反馈</div>' + d.items.map(function (f) {
          const ai = f.ai;
          const badge = !ai ? '<span class="tag">AI 审阅中</span>'
            : '<span class="tag ' + (ai.valid === 'no' ? '' : 'gold') + '">' + window.Md.esc(ai.category || '已审阅') + '</span>';
          return '<div class="review-item" style="padding:10px 12px;margin-bottom:8px">'
            + badge + ' <span class="small muted">' + window.UI.fmtDate(f.createdAt) + '</span>'
            + '<div style="margin:6px 0">' + window.Md.esc(f.content) + '</div>'
            + (ai ? '<div class="small muted">AI 摘要：' + window.Md.esc(ai.summary) + '</div>' : '')
            + '</div>';
        }).join('');
      }).catch(function () {});
    }
    el.querySelector('#fbMine').addEventListener('click', loadMine);
    loadMine();

    el.querySelector('#fbSend').addEventListener('click', async function () {
      const btn = this;
      const content = el.querySelector('#fbContent').value.trim();
      const msg = el.querySelector('#fbMsg');
      if (content.length < 6) { msg.textContent = '反馈内容至少 6 个字'; return; }
      msg.textContent = '';
      btn.disabled = true;
      try {
        await window.API.post('/api/problems/' + p.code + '/feedback', {
          type: el.querySelector('#fbType').value,
          content: content,
          imageDesc: el.querySelector('#fbImageDesc').value.trim()
        });
        window.UI.toast('已提交，AI 审阅后会转给管理员', 'ok');
        el.querySelector('#fbContent').value = '';
        loadMine();
      } catch (e) {
        msg.textContent = e.message;
      } finally {
        btn.disabled = false;
      }
    });
  }

  function renderDiscussion(slot, code) {
    if (!slot) return;
    slot.innerHTML =
      '<div class="card discuss-card">'
      + '<div class="discuss-head"><h3>这道题的讨论</h3><span class="small muted" id="discussCount"></span>'
      + '<button class="btn btn-sm right" id="discussNew">发帖</button></div>'
      + '<div id="discussList"><div class="loading-row"><span class="spinner"></span>加载中…</div></div>'
      + '</div>';

    function load() {
      window.API.get('/api/forum?code=' + encodeURIComponent(code) + '&size=20').then(function (d) {
        const box = slot.querySelector('#discussList');
        slot.querySelector('#discussCount').textContent = d.total ? d.total + ' 条' : '还没有人讨论';
        if (!d.items.length) {
          box.innerHTML = '<div class="empty" style="padding:22px"><b>这里还空着</b>卡在哪一步，直接问。AI 会先回一条。</div>';
          return;
        }
        box.innerHTML = d.items.map(function (it) {
          return '<a class="discuss-item" href="#/post/' + it.id + '">'
            + '<span class="dt">' + window.Md.esc(it.title) + '</span>'
            + (it.image ? '<span class="tag">图</span>' : '')
            + '<span class="dmeta">' + window.Md.esc(it.authorName) + ' · ' + window.UI.timeAgo(it.createdAt)
            + ' · ' + it.replyCount + ' 回复</span></a>';
        }).join('');
      }).catch(function () {
        slot.querySelector('#discussList').innerHTML = '<div class="small muted" style="padding:12px">加载失败</div>';
      });
    }

    slot.querySelector('#discussNew').addEventListener('click', function () {
      if (!window.UI.requireLogin(null, '登录后才能发帖')) return;
      const el = document.createElement('div');
      el.innerHTML =
        '<div class="field"><label>标题</label><input id="dTitle" maxlength="100" placeholder="比如：第 2 步换元后上限怎么定" /></div>'
        + '<div class="field"><label>内容</label><textarea id="dBody" rows="5" placeholder="说清卡在哪一步、你试过什么"></textarea></div>'
        + '<div class="field"><label>配图（可选）</label>'
        + '<input type="file" id="dFile" accept="image/*" style="display:none" />'
        + '<div class="upload-row"><button type="button" class="btn btn-sm" id="dPick">选择图片</button>'
        + '<span class="small muted" id="dHint">手写过程拍照最直观</span></div><div id="dPreview"></div></div>'
        + '<div style="display:flex;justify-content:flex-end;gap:9px"><button class="btn btn-primary" id="dSend">发帖</button></div>';

      const m = window.UI.modal({ title: '发帖 · ' + code, body: el, wide: true });
      if (window.MathKey) window.MathKey.attachAll(el);
      let image = '';
      el.querySelector('#dPick').addEventListener('click', function () { el.querySelector('#dFile').click(); });
      el.querySelector('#dFile').addEventListener('change', function (ev) {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        const rd = new FileReader();
        rd.onload = function () {
          const img = new Image();
          img.onload = function () {
            const max = 1400;
            const sc = Math.min(1, max / Math.max(img.width, img.height));
            const cv = document.createElement('canvas');
            cv.width = Math.round(img.width * sc);
            cv.height = Math.round(img.height * sc);
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            image = cv.toDataURL('image/jpeg', 0.85);
            el.querySelector('#dPreview').innerHTML = '<img src="' + image + '" class="judge-img" alt="预览" />';
            el.querySelector('#dHint').textContent = '已选择图片';
          };
          img.src = String(rd.result);
        };
        rd.readAsDataURL(file);
      });

      el.querySelector('#dSend').addEventListener('click', async function () {
        const title = el.querySelector('#dTitle').value.trim();
        const bodyText = el.querySelector('#dBody').value.trim();
        if (title.length < 4) { window.UI.toast('标题至少 4 个字', 'err'); return; }
        if (bodyText.length < 6 && !image) { window.UI.toast('写点内容或传张图', 'err'); return; }
        this.disabled = true;
        try {
          await window.API.post('/api/forum', { title: title, body: bodyText || '见图', problemCode: code, image: image || undefined });
          window.UI.toast('已发布，AI 正在回复', 'ok');
          m.close();
          load();
        } catch (e) {
          window.UI.toast(e.message, 'err');
          this.disabled = false;
        }
      });
    });

    load();
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
        + '    <span class="m">平均分 <b>' + (p.avgScore === null || p.avgScore === undefined ? '—' : p.avgScore) + '</b>' + (p.scoreCount ? '(' + p.scoreCount + ')' : '') + '</span>'
        + '    <span class="m">我的最高 <b>' + (p.myBest === null || p.myBest === undefined ? '—' : p.myBest) + '</b></span>'
        + '  </div>'
        + '  <div class="statement" id="stmt"></div>'
        + '  <div class="score-panel">'
        + '    <div class="score-item"><div class="score-top"><span>思维量</span><b>' + p.thinking + '</b></div><div class="score-track"><div class="score-fill ' + (p.thinking >= 8 ? 'hi' : '') + '" style="width:' + p.thinking * 10 + '%"></div></div></div>'
        + '    <div class="score-item"><div class="score-top"><span>难度</span><b>' + p.difficulty + '</b></div><div class="score-track"><div class="score-fill ' + (p.difficulty >= 10 ? 'hi' : 'mid') + '" style="width:' + Math.min(100, p.difficulty / 15 * 100) + '%"></div></div></div>'
        + '    <div class="score-item"><div class="score-top"><span>计算量</span><b>' + p.calc + '</b></div><div class="score-track"><div class="score-fill" style="width:' + p.calc * 10 + '%"></div></div></div>'
        + '    <div class="score-note"><span>思维量 = 想到方法的难度（纯计算题通常 ≤4）；计算量 = 算到底的工作量；难度上限 15</span><span>难度：' + window.UI.levelOf(p.difficulty).name + '</span></div>'
        + '  </div>'
        + '  <div class="actions" id="actionBar">'
        + '    <button class="btn btn-primary" id="solveBtn">' + (solved ? '已通过（+' + data.xpRules.base + ' 经验上限）' : '提交解题过程') + '</button>'
        + '    <button class="btn" id="hintBtn">' + window.UI.icon('spark') + ' 先给点提示</button>'
        + '    <button class="btn" id="answerBtn">查看答案</button>'
        + '    <button class="btn btn-ok" id="askBtn">' + window.UI.icon('spark') + ' 问 AI 助教</button>'
        + '    <button class="btn" id="feedbackBtn" title="反馈题目错误，AI 审阅后转管理员">反馈题目</button>'
        + '  </div>'
        + '  <div id="answerSlot"></div>'
        + '  <div id="discussSlot" style="margin-top:18px"></div>'
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
        + '      看过答案：经验 <b>−40%</b><br/>'
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
      renderDiscussion(document.getElementById('discussSlot'), p.code);

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

      /* 提交解题过程 → AI 批改 */
      const solveBtn = document.getElementById('solveBtn');
      solveBtn.disabled = solved;
      if (solved) solveBtn.classList.add('btn-ok');
      solveBtn.addEventListener('click', function () {
        if (!window.UI.requireLogin(null, '登录后才能提交解题过程')) return;
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
            + '<span class="small muted right">看答案后经验 −40%</span></div>'
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

      /* 题目反馈 */
      document.getElementById('feedbackBtn').addEventListener('click', function () {
        openFeedbackModal(p);
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
