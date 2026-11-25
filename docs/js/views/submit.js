/* 投稿 + 我的记录 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};
  const St = window.API.State;

  function loginGate(el, text) {
    el.innerHTML = '<div class="page-head"><div><h1>' + text + '</h1></div></div>'
      + '<div class="empty"><b>这一步需要登录</b>登录后才能投稿、记录经验与发帖。'
      + '<div style="margin-top:16px"><button class="btn btn-primary" id="gateLogin">登录 / 注册</button></div></div>';
    document.getElementById('gateLogin').addEventListener('click', function () { window.UI.authModal('login'); });
  }

  Views.submit = function (el) {
    if (!St.me) return loginGate(el, '投稿好题');

    el.innerHTML =
      '<div class="page-head"><div><h1>投稿好题</h1>'
      + '<p class="sub">投稿不会立刻出现在题库里：管理员会逐题核对题干、解答与三个维度的评分，通过后才入库。通过后你获得 30 经验。</p></div>'
      + '<div class="head-actions"><a class="btn" href="#/my">我的投稿</a></div></div>'

      + '<div class="submit-grid">'
      + '<form class="card form-card" id="submitForm">'
      + '<div class="form-section-title">从图片开始（可选）</div>'
      + '<div class="ocr-box">'
      + '<input type="file" id="ocrFile" accept="image/*" style="display:none" />'
      + '<div class="upload-row"><button type="button" class="btn btn-sm" id="ocrPick">选一张题目图片</button>'
      + '<span class="small muted" id="ocrHint">有视觉模型 Key 时自动补全题目、答案与解析；没有就走下面的提示词</span></div>'
      + '<div id="ocrPreview"></div><div id="ocrResult"></div></div>'
      + '<div class="form-section-title">题目基本信息</div>'
      + '<div class="field"><label>标题 *</label><input name="title" maxlength="120" placeholder="给这道题起一个能记住的标题" /></div>'
      + '<div class="field"><label>题干 *</label><textarea name="statement" rows="7" placeholder="完整题干。行内公式 $...$，独立公式 $$...$$"></textarea>'
      + '<div class="tip">支持 Markdown 与 LaTeX，例如 $$\\lim_{x\\to 0}\\frac{\\sin x}{x}=1$$</div></div>'
      + '<div class="field-row">'
      + '<div class="field"><label>来源</label><input name="source" maxlength="80" placeholder="教材 / 考研真题 / 自编" /></div>'
      + '<div class="field"><label>考点标签（逗号分隔）</label><input name="tags" placeholder="极限, 泰勒展开" /></div>'
      + '</div>'

      + '<div class="form-section-title">三维评分（思维量/计算量 1-10，难度 1-15）</div>'
      + rangeRow('thinking', '思维量', 5, '只算「想到方法」有多难：套公式的纯计算题给 2-4 分')
      + rangeRow('difficulty', '难度', 5, '综合难度，特别难题可以超过 10')
      + rangeRow('calc', '计算量', 5, '算到底需要多少工作量')

      + '<div class="form-section-title">解答（审核时必看）</div>'
      + '<div class="field"><label>分层提示（每行一条，最多 5 条）</label><textarea name="hints" rows="3" placeholder="第一句给方向，不要直接给答案"></textarea></div>'
      + '<div class="field"><label>最终答案</label><input name="answer" placeholder="例如 $\\frac{1}{2}$" /></div>'
      + '<div class="field"><label>完整解析 *</label><textarea name="solution" rows="8" placeholder="分步写清楚，审核会按这个判断质量"></textarea></div>'
      + '<div class="form-error" id="subErr"></div>'
      + '<div style="display:flex;gap:10px;align-items:center">'
      + '<button type="submit" class="btn btn-primary" id="subBtn">提交审核</button>'
      + '<span class="small muted">提交后可在「我的投稿」里看审核状态</span></div>'
      + '</form>'

      + '<aside>'
      + '<div class="card side-card"><h3>入库标准</h3><div class="xp-rule">'
      + '1. 题干完整、无歧义，条件够用<br/>'
      + '2. 有可复现的完整解答<br/>'
      + '3. 三维评分与实际相符<br/>'
      + '4. 考点标签准确，便于检索<br/>'
      + '5. 不重复已有题目</div></div>'
      + '<div class="card side-card"><h3>格式提示</h3><div class="xp-rule">'
      + '行内公式：<code>$x^2$</code><br/>'
      + '独立公式：<code>$$\\int_0^1 x\\,dx$$</code><br/>'
      + '换行直接回车即可</div></div>'
      + '</aside></div>';

    if (window.MathKey) {
      window.MathKey.attach(document.querySelector('textarea[name="statement"]'));
      window.MathKey.attach(document.querySelector('textarea[name="solution"]'));
    }

    document.querySelectorAll('input[type="range"]').forEach(function (r) {
      const out = document.getElementById('v_' + r.name);
      r.addEventListener('input', function () { out.textContent = r.value; });
    });

    /* 识图补全 */
    (function bindOcr() {
      const pick = document.getElementById('ocrPick');
      const file = document.getElementById('ocrFile');
      if (!pick) return;
      let image = '';
      pick.addEventListener('click', function () { file.click(); });
      file.addEventListener('change', function (ev) {
        const f = ev.target.files && ev.target.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = function () {
          const img = new Image();
          img.onload = function () {
            const max = 1600;
            const sc = Math.min(1, max / Math.max(img.width, img.height));
            const cv = document.createElement('canvas');
            cv.width = Math.round(img.width * sc);
            cv.height = Math.round(img.height * sc);
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            image = cv.toDataURL('image/jpeg', 0.85);
            document.getElementById('ocrPreview').innerHTML = '<img src="' + image + '" class="judge-img" alt="题目预览" />'
              + '<div style="margin-top:8px"><button type="button" class="btn btn-primary btn-sm" id="ocrGo">识图补全</button></div>';
            document.getElementById('ocrGo').addEventListener('click', runOcr);
          };
          img.src = String(rd.result);
        };
        rd.readAsDataURL(f);
      });

      async function runOcr() {
        const box = document.getElementById('ocrResult');
        box.innerHTML = '<div class="small muted" style="padding:8px 0">识别中…</div>';
        try {
          const res = await window.API.post('/api/ai/from-image', { image: image, llm: window.UI.llmConfig() });
          if (res.ok) {
            const p = res.problem;
            const fm = document.getElementById('submitForm');
            fm.title.value = p.title || '';
            fm.statement.value = p.statement || '';
            fm.tags.value = (p.tags || []).join(', ');
            fm.answer.value = p.answer || '';
            fm.solution.value = p.solution || '';
            fm.hints.value = (p.hints || []).join('\n');
            fm.difficulty.value = p.difficulty || 5;
            fm.thinking.value = p.thinking || 5;
            fm.calc.value = p.calc || 5;
            ['difficulty', 'thinking', 'calc'].forEach(function (k) {
              const lbl = document.getElementById('v_' + k);
              if (lbl) lbl.textContent = fm[k].value;
            });
            box.innerHTML = '<div class="judge-result correct"><b>已补全</b><span>核对一遍再提交，AI 转写可能漏字</span></div>';
            return;
          }
          // 没有视觉模型：先用浏览器 OCR 把图片转成文字，填进题干框让用户核对
          if (window.OCR) {
            try {
              let text = window.OCR.tidy(await window.OCR.imageToText(image, function (pct) {
                box.innerHTML = '<div class="small muted" style="padding:8px 0">本地 OCR 识别中 ' + pct + '%…</div>';
              }));
              if (text) {
                // 关键一步：tesseract 只认字形，交给 AI 按上下文改写成合法 LaTeX
                if (window.OCR.polishWithAI) {
                  box.innerHTML = '<div class="small muted" style="padding:8px 0">正在把识别结果规范成 LaTeX…</div>';
                  try {
                    const polished = await window.OCR.polishWithAI(text, { llm: window.UI.llmConfig() });
                    if (polished && polished.trim().length > 8) text = polished;
                  } catch (e2) {
                    console.warn('[ocr] AI 规范化失败，用原始识别结果', e2.message);
                  }
                }
                if (window.OCR.repairDelims) text = window.OCR.repairDelims(text);
                const fm = document.getElementById('submitForm');
                fm.statement.value = text;
                box.innerHTML = '<div class="judge-result correct"><b>已 OCR 识别</b>'
                  + '<span>已尽量规范成 LaTeX，公式仍需你核对一遍；答案与解析请补全</span></div>';
                return;
              }
            } catch (e) {
              box.innerHTML = '<div class="small muted" style="padding:8px 0">本地 OCR 不可用：' + window.Md.esc(e.message) + '，可改用下面的提示词。</div>';
            }
          }
          // OCR 也不可用：给提示词，让用户去别处识别后粘回来
          box.innerHTML = '<div class="judge-errors" style="border-color:'+window.UI.tone('panelLine')+';background:'+window.UI.tone('panel')+'">'
            + '<div class="je-head" style="color:'+window.UI.tone('info')+'">当前通道读不了图片</div>'
            + '<div class="small" style="line-height:1.9;color:var(--text-2)">把下面这段提示词和图片一起发给任意能看图的 AI（豆包 / Kimi / 通义千问网页版都行），'
            + '把它的回答原样粘到「题干」里，我来解析。</div>'
            + '<textarea readonly rows="9" id="ocrPrompt" style="width:100%;margin-top:8px;font-size:12px">' + window.Md.esc(res.prompt || '') + '</textarea>'
            + '<div style="margin-top:8px;display:flex;gap:8px"><button type="button" class="btn btn-sm" id="copyPrompt">复制提示词</button>'
            + '<button type="button" class="btn btn-sm" id="pasteBack">粘贴回答并解析</button></div>'
            + '<div id="pasteResult"></div></div>';
          document.getElementById('copyPrompt').addEventListener('click', function () {
            const ta = document.getElementById('ocrPrompt');
            ta.select();
            try { document.execCommand('copy'); window.UI.toast('提示词已复制', 'ok'); } catch (e) {}
          });
          document.getElementById('pasteBack').addEventListener('click', async function () {
            const text = window.prompt('把 AI 的回答整段粘进来：');
            if (!text) return;
            try {
              const parsed = await window.API.post('/api/ai/parse', { text: text });
              const p = parsed.problem;
              const fm = document.getElementById('submitForm');
              fm.title.value = p.title || '';
              fm.statement.value = p.statement || '';
              fm.tags.value = (p.tags || []).join(', ');
              fm.answer.value = p.answer || '';
              fm.solution.value = p.solution || '';
              document.getElementById('pasteResult').innerHTML = '<div class="judge-result correct" style="margin-top:8px"><b>已填入表单</b></div>';
            } catch (e) {
              window.UI.toast(e.message, 'err');
            }
          });
        } catch (e) {
          box.innerHTML = '<div class="judge-result wrong">' + window.Md.esc(e.message) + '</div>';
        }
      }
    })();

    const form = document.getElementById('submitForm');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      const err = document.getElementById('subErr');
      const btn = document.getElementById('subBtn');
      const title = form.title.value.trim();
      const statement = form.statement.value.trim();
      const solution = form.solution.value.trim();
      if (!title || !statement) { err.textContent = '标题和题干必填'; return; }
      if (!solution) { err.textContent = '请填写完整解析，审核时必看'; return; }
      btn.disabled = true;
      btn.textContent = '提交中…';
      try {
        const res = await window.API.post('/api/submit', {
          title: title,
          statement: statement,
          source: form.source.value.trim(),
          tags: form.tags.value,
          thinking: form.thinking.value,
          difficulty: form.difficulty.value,
          calc: form.calc.value,
          hints: form.hints.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
          answer: form.answer.value.trim(),
          solution: solution
        });
        el.innerHTML = '<div class="empty" style="padding:80px 20px"><b>已提交，编号 ' + res.code + '</b>'
          + '管理员审核通过后才会进入题库。审核结果在「我的投稿」里可见。'
          + '<div style="margin-top:18px;display:flex;gap:10px;justify-content:center">'
          + '<a class="btn" href="#/my">我的投稿</a><a class="btn btn-primary" href="#/submit">再投一题</a></div></div>';
        window.UI.toast('投稿成功，等待人工审核', 'ok');
      } catch (err2) {
        err.textContent = err2.message;
        btn.disabled = false;
        btn.textContent = '提交审核';
      }
    });

    function rangeRow(name, label, val, tip) {
      const max = name === 'difficulty' ? 15 : 10;
      return '<div class="range-row"><span class="lab">' + label + '</span>'
        + '<input type="range" name="' + name + '" min="1" max="' + max + '" step="1" value="' + val + '" title="' + tip + '" />'
        + '<span class="val" id="v_' + name + '">' + val + '</span></div>';
    }
  };

  /* ---------------------------------------------------------- 我的记录 */

  Views.my = function (el) {
    if (!St.me) return loginGate(el, '我的记录');
    el.innerHTML = '<div class="loading-row"><span class="spinner"></span>正在读取你的记录…</div>';

    Promise.all([
      window.API.get('/api/me'),
      window.API.get('/api/my/submissions').catch(function () { return { items: [] }; }),
      window.API.get('/api/my/solved').catch(function () { return { items: [] }; }),
      window.API.get('/api/my/attempts').catch(function () { return { items: [] }; }),
      window.API.get('/api/my/stats').catch(function () { return { tags: [], weakest: [], recommend: [], summary: {} }; })
    ]).then(function (arr) {
      const me = arr[0].user;
      const subs = arr[1].items || [];
      const solved = arr[2].items || [];
      const attempts = arr[3].items || [];
      const stats = arr[4] || { tags: [], weakest: [], recommend: [], summary: {} };
      window.UI.applyUser(me);

      /* 考点雷达：取做题量前 6 的标签，纯 SVG 不用图表库 */
      const radar = function (tags) {
        const list = (tags || []).slice(0, 6);
        if (list.length < 3) return '<div class="small muted">做过 3 个以上考点的题之后，这里会出现考点雷达。</div>';
        const cx = 130, cy = 118, R = 82;
        const n = list.length;
        const pt = function (i, r) {
          const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
          return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
        };
        const rings = [0.33, 0.66, 1].map(function (k) {
          const d = list.map(function (_, i) { return pt(i, R * k).map(function (v) { return v.toFixed(1); }).join(','); }).join(' ');
          return '<polygon points="' + d + '" fill="none" stroke="var(--line)" stroke-width="1"/>';
        }).join('');
        const axes = list.map(function (_, i) {
          const e = pt(i, R);
          return '<line x1="' + cx + '" y1="' + cy + '" x2="' + e[0].toFixed(1) + '" y2="' + e[1].toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>';
        }).join('');
        const poly = list.map(function (t, i) {
          const r = R * Math.max(0.08, Math.min(1, (t.rate || 0) / 100));
          return pt(i, r).map(function (v) { return v.toFixed(1); }).join(',');
        }).join(' ');
        const labels = list.map(function (t, i) {
          const e = pt(i, R + 18);
          const txt = String(t.tag).slice(0, 6);
          return '<text x="' + e[0].toFixed(1) + '" y="' + e[1].toFixed(1) + '" font-size="10" fill="var(--text-2)" text-anchor="middle">'
            + window.Md.esc(txt) + '</text>';
        }).join('');
        return '<svg viewBox="0 0 260 240" width="100%" style="max-width:280px">'
          + rings + axes
          + '<polygon points="' + poly + '" fill="rgba(78,140,255,.22)" stroke="#4f8cff" stroke-width="2"/>'
          + labels + '</svg>';
      };

      const statsCard = stats.tags && stats.tags.length
        ? '<div class="card side-card" style="padding:18px 20px;margin-bottom:14px">'
          + '<h3>考点雷达</h3>'
          + '<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">'
          + '<div style="flex:1;min-width:220px">' + radar(stats.tags) + '</div>'
          + '<div style="flex:1;min-width:220px">'
          + '<div class="small muted">正确率 = 通过题数 / 做过题数</div>'
          + (stats.weakest.length
            ? '<div style="margin-top:8px"><b>薄弱考点</b></div>'
              + stats.weakest.map(function (w) {
                return '<div class="related-item"><span class="t">' + window.Md.esc(w.tag) + '</span>'
                  + '<span class="tag red">' + w.rate + '%</span></div>';
              }).join('')
            : '<div class="small muted" style="margin-top:8px">暂时没有薄弱考点。</div>')
          + (stats.recommend.length
            ? '<div style="margin-top:10px"><b>按薄弱考点推荐</b></div>'
              + stats.recommend.slice(0, 4).map(function (r) {
                return '<a class="related-item" href="#/problem/' + r.code + '"><span class="code">' + r.code + '</span>'
                  + '<span class="t">' + window.Md.inlineTex(r.title) + '</span>'
                  + '<span class="tag">' + window.Md.esc(r.tag) + '</span></a>';
              }).join('')
            : '')
          + '</div></div></div>'
        : '';

      el.innerHTML =
        '<div class="page-head"><div><h1>' + window.Md.esc(me.name) + '</h1>'
        + '<p class="sub">Lv.' + me.level + ' · ' + me.exp + ' 经验 · 已做出 ' + me.solvedCount + ' 题'
        + (me.role === 'admin' ? ' · 管理员' : '') + '</p></div>'
        + '<div class="head-actions"><a class="btn" href="#/problems?status=unsolved">继续刷题</a></div></div>'

        + '<div class="stat-strip">'
        + '<div class="stat"><div class="k">等级</div><div class="v">Lv.' + me.level + '</div></div>'
        + '<div class="stat"><div class="k">经验</div><div class="v">' + me.exp + '</div></div>'
        + '<div class="stat"><div class="k">已做出</div><div class="v">' + me.solvedCount + '<small>题</small></div></div>'
        + '<div class="stat"><div class="k">待审投稿</div><div class="v">' + subs.filter(function (s) { return s.status === 'pending'; }).length + '</div></div>'
        + '</div>'
        + statsCard

        + '<div class="submit-grid">'
        + '<div>'
        + '<div class="card side-card" style="padding:18px 20px"><h3>做题记录</h3>'
        + (solved.length
          ? solved.map(function (s) {
            return '<a class="related-item" href="#/problem/' + s.code + '"><span class="code">' + s.code + '</span>'
              + '<span class="t">' + window.Md.inlineTex(s.title) + '</span>'
              + (s.revealed ? '<span class="tag gold">看过答案</span>' : '<span class="tag teal">独立完成</span>') + '</a>';
          }).join('')
          : '<div class="small muted">还没有做题记录，去题库挑一道。</div>')
        + '</div>'
        + '<div class="card side-card" style="padding:18px 20px;margin-top:14px"><h3>最近作答</h3>'
        + (attempts.length
          ? attempts.slice(0, 12).map(function (a) {
            const tone = a.verdict === 'correct' ? 'teal' : a.verdict === 'partial' ? 'gold'
              : a.verdict === 'wrong' ? 'red' : 'gray';
            const label = a.verdict === 'correct' ? '通过' : a.verdict === 'partial' ? '部分对'
              : a.verdict === 'wrong' ? '未通过' : '未判定';
            return '<a class="related-item" href="#/problem/' + a.code + '">'
              + '<span class="code">' + a.code + '</span>'
              + '<span class="t">' + window.Md.inlineTex(a.title) + '</span>'
              + '<span class="tag ' + tone + '">' + label + ' ' + (Number.isFinite(a.score) ? a.score : 0) + ' 分</span></a>';
          }).join('')
          : '<div class="small muted">还没有提交记录。做完一道题交上来，这里会留一次底。</div>')
        + (attempts.length > 12 ? '<div class="small muted" style="margin-top:6px">只显示最近 12 次</div>' : '')
        + '</div>'
        + '<div class="card side-card" style="padding:18px 20px;margin-top:14px"><h3>我的投稿</h3>'
        + (subs.length
          ? subs.map(function (s) {
            return '<div class="related-item" style="align-items:flex-start">'
              + '<span class="code">' + s.code + '</span>'
              + '<span class="t" style="white-space:normal">' + window.Md.inlineTex(s.title)
              + (s.status === 'rejected' && s.rejectReason ? '<div class="small" style="color:'+window.UI.tone('err')+';margin-top:2px">驳回：' + window.Md.esc(s.rejectReason) + '</div>' : '')
              + '</span>'
              + '<span class="tag ' + (s.status === 'pending' ? 'gold' : 'gray') + '">' + (s.status === 'pending' ? '待审核' : '已驳回') + '</span></div>';
          }).join('')
          : '<div class="small muted">还没有投稿。</div>')
        + '</div>'
        + '</div>'

        + '<aside>'
        + '<div class="card side-card"><h3>账号状态</h3>'
        + (me.emailVerified
          ? '<div class="xp-rule">已绑定邮箱 <b>' + window.Md.esc(me.email) + '</b><br/>发帖与回复不受每小时 1 条的限制。</div>'
          : '<div class="xp-rule" style="margin-bottom:10px">未绑定邮箱：<b>每小时只能发 1 条帖、1 条回复</b>。绑定后解除。</div>'
            + '<div class="field"><label>邮箱</label><input id="bindEmail" type="email" placeholder="you@example.com" /></div>'
            + '<button class="btn btn-sm btn-primary" id="bindSend">发送验证码</button>'
            + '<div class="field" style="margin-top:10px"><label>验证码</label><input id="bindCode" inputmode="numeric" maxlength="6" placeholder="6 位数字" /></div>'
            + '<button class="btn btn-sm" id="bindVerify">完成绑定</button>'
            + '<div class="small muted" id="bindMsg" style="margin-top:8px"></div>')
        + '</div>'
        + '<div class="card side-card"><h3>等级进度</h3>'
        + '<div class="xp-rule">当前 Lv.' + me.level + '，进度 ' + Math.round((me.levelProgress || 0) * 100) + '%<br/>'
        + '<div class="score-track" style="margin:8px 0"><div class="score-fill" style="width:' + Math.round((me.levelProgress || 0) * 100) + '%"></div></div>'
        + '做题、投稿通过都会加经验；同一道题只计一次。</div></div>'
        + '<div class="card side-card"><h3>最近动态</h3><div class="xp-rule">'
        + (arr[0].activity && arr[0].activity.length
          ? arr[0].activity.slice(0, 8).map(function (a) {
            return '<div style="padding:4px 0;border-bottom:1px dashed var(--border-soft)">' + window.Md.esc(a.text)
              + '<div class="small muted">' + window.UI.timeAgo(a.at) + '</div></div>';
          }).join('')
          : '还没有动态')
        + '</div></div>'
        + '<div class="card side-card"><h3>账号安全</h3>'
        + '<div class="field" style="margin-bottom:8px"><input id="oldPwd" type="password" placeholder="原密码" autocomplete="current-password" /></div>'
        + '<div class="field" style="margin-bottom:10px"><input id="newPwd" type="password" placeholder="新密码（至少 8 位）" autocomplete="new-password" /></div>'
        + '<button class="btn btn-sm" id="pwdBtn">修改密码</button>'
        + '</div>'
        + '</aside></div>';

      const pwdBtn = document.getElementById('pwdBtn');
      pwdBtn.addEventListener('click', async function () {
        const oldPwd = document.getElementById('oldPwd').value;
        const newPwd = document.getElementById('newPwd').value;
        if (!oldPwd || !newPwd) { window.UI.toast('原密码和新密码都要填', 'err'); return; }
        pwdBtn.disabled = true;
        try {
          await window.API.post('/api/auth/password', { oldPassword: oldPwd, newPassword: newPwd });
          document.getElementById('oldPwd').value = '';
          document.getElementById('newPwd').value = '';
          window.UI.toast('密码已更新', 'ok');
        } catch (e) {
          window.UI.toast(e.message, 'err');
        } finally {
          pwdBtn.disabled = false;
        }
      });
      // 邮箱绑定
      const bindSend = document.getElementById('bindSend');
      if (bindSend) {
        const msg = document.getElementById('bindMsg');
        bindSend.addEventListener('click', async function () {
          const email = document.getElementById('bindEmail').value.trim();
          if (!email) { window.UI.toast('先填邮箱', 'err'); return; }
          bindSend.disabled = true;
          try {
            const r = await window.API.post('/api/me/email/send', { email: email });
            msg.textContent = r.code ? ('站点未接邮件服务，验证码：' + r.code) : (r.message || '验证码已发送');
            if (r.code) document.getElementById('bindCode').value = r.code;
          } catch (e) { msg.textContent = e.message; }
          finally { bindSend.disabled = false; }
        });

        document.getElementById('bindVerify').addEventListener('click', async function () {
          const code = document.getElementById('bindCode').value.trim();
          if (!code) { window.UI.toast('填验证码', 'err'); return; }
          try {
            const r = await window.API.post('/api/me/email/verify', { code: code });
            window.UI.applyUser(r.user);
            window.UI.toast('邮箱绑定成功，发帖限制已解除', 'ok');
            window.App.render();
          } catch (e) { msg.textContent = e.message; }
        });
      }

    }).catch(function (e) {
      el.innerHTML = window.UI.empty('加载失败', e.message);
    });
  };
})();
