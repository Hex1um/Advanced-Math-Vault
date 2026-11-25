/* 审核后台 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};
  const St = window.API.State;

  function scoreInput(name, value) {
    return '<div class="field"><label>' + name + '</label><input type="number" min="1" max="10" value="' + value + '" data-f="' + name + '" /></div>';
  }

  async function openProblemEditor(fb) {
    let data;
    try {
      data = await window.API.get('/api/admin/problem/' + encodeURIComponent(fb.code));
    } catch (e) {
      window.UI.toast(e.message, 'err');
      return;
    }
    const p = data.problem || {};
    const body = document.createElement('div');
    body.innerHTML = '<div class="field"><label>标题</label><input id="epTitle" value="' + window.Md.esc(p.title || '') + '" /></div>'
      + '<div class="field"><label>题干</label><textarea id="epStatement" rows="10" style="width:100%">' + window.Md.esc(p.statement || '') + '</textarea></div>'
      + '<div class="field"><label>最终答案</label><input id="epAnswer" value="' + window.Md.esc(p.answer || '') + '" /></div>'
      + '<div class="field"><label>完整解析</label><textarea id="epSolution" rows="12" style="width:100%">' + window.Md.esc(p.solution || '') + '</textarea></div>'
      + '<div class="field"><label>分层提示（每行一条）</label><textarea id="epHints" rows="3" style="width:100%">' + window.Md.esc((p.hints || []).join('\n')) + '</textarea></div>'
      + '<div class="small muted" id="epMsg">保存后立即生效，并自动把这条反馈标为已处理。</div>'
      + '<div style="display:flex;gap:10px;margin-top:12px"><button class="btn btn-primary" id="epSave">保存修改</button>'
      + '<button class="btn" id="epCancel">取消</button></div>';
    const modal = window.UI.modal({ title: '修改题目 · ' + fb.code, sub: '管理员直接编辑，保存后同步到题库', body: body, wide: true });
    if (window.MathKey) window.MathKey.attachAll(body);
    body.querySelector('#epCancel').addEventListener('click', modal.close);
    body.querySelector('#epSave').addEventListener('click', async function () {
      const btn = body.querySelector('#epSave');
      const msg = body.querySelector('#epMsg');
      const payload = {
        title: body.querySelector('#epTitle').value,
        statement: body.querySelector('#epStatement').value,
        answer: body.querySelector('#epAnswer').value,
        solution: body.querySelector('#epSolution').value,
        hints: body.querySelector('#epHints').value.split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean),
        feedbackId: fb.id
      };
      btn.disabled = true; btn.textContent = '保存中…';
      try {
        await window.API.post('/api/admin/problem/' + encodeURIComponent(fb.code), payload);
        window.UI.toast('题目已更新', 'ok');
        modal.close();
        loadFeedback();
      } catch (e) {
        msg.textContent = e.message;
        msg.style.color = window.UI.tone('err');
        btn.disabled = false; btn.textContent = '保存修改';
      }
    });
  }

  async function loadFeedback() {
    const wrap = document.getElementById('feedbackList');
    if (!wrap) return;
    try {
      const d = await window.API.get('/api/admin/feedbacks');
      const cnt = document.getElementById('fbCount');
      if (cnt) cnt.textContent = d.stats.open + ' 条待处理';
      const reviewing = document.getElementById('fbReviewing');
      if (reviewing) reviewing.textContent = d.stats.reviewing ? ('AI 正在审阅 ' + d.stats.reviewing + ' 条，稍后刷新即可看到') : '';

      const Item = function (f) {
        const ai = f.ai || {};
        const validTag = ai.valid === 'no' ? '<span class="tag">疑似无效</span>'
          : ai.valid === 'yes' ? '<span class="tag gold">有效反馈</span>' : '<span class="tag">待复核</span>';
        const codeHtml = f.problemDeleted
          ? '<span class="mono">' + window.Md.esc(f.code) + '</span><span class="tag">题目已删除</span>'
          : '<a class="mono" href="#/problem/' + f.code + '">' + f.code + '</a>';
        return '<div class="review-item" data-fid="' + f.id + '" style="padding:14px;margin-bottom:12px;border:1px solid var(--border,#dde);border-radius:8px">'
          + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
          + codeHtml
          + '<span class="tag">' + window.Md.esc(f.typeName || '其他') + '</span>' + validTag
          + '<span class="tag">' + window.Md.esc(ai.category || '未分类') + '</span>'
          + '<span class="small muted">' + window.Md.esc(f.userName || '用户') + ' · ' + window.UI.fmtDate(f.createdAt) + '</span>'
          + (f.status !== 'open' ? '<span class="tag">' + (f.status === 'resolved' ? '已处理' : '已忽略') + '</span>' : '')
          + '</div>'
          + '<div class="small muted" style="margin:8px 0 4px">题目：' + window.Md.inlineTex(f.title || '') + '</div>'
          + '<div style="margin:8px 0"><b>用户原文：</b>' + window.Md.esc(f.content) + '</div>'
          + (ai.summary ? '<div class="small" style="margin:6px 0"><b>AI 摘要：</b>' + window.Md.esc(ai.summary) + '</div>' : '')
          + (ai.advice ? '<div class="small" style="margin:6px 0"><b>AI 建议：</b>' + window.Md.esc(ai.advice) + '</div>' : '')
          + '<div class="small muted" style="margin:6px 0">审阅模型：' + window.Md.esc(ai.model || '—') + '</div>'
          + (f.type === 'appeal' && f.submissionId
            ? '<div class="appeal-box" style="margin:10px 0;padding:10px;border:1px dashed var(--line);border-radius:8px">'
              + '<div class="small muted">这条是判分申诉，原 AI 打分 <b>' + (f.submissionScore || 0) + ' 分</b>（' + window.Md.esc(f.submissionAt || '') + '）</div>'
              + '<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">'
              + '<input class="ap-score" type="number" min="0" max="100" placeholder="改判分数 0-100" style="width:150px" />'
              + '<button class="btn btn-sm btn-ok" data-fact="override">按此分数改判</button>'
              + '<span class="small muted">改到 80 分以上会自动通过并补发经验</span></div></div>'
            : '')
          + '<div class="field" style="margin-top:8px"><input class="fb-note" placeholder="处理备注（选填）" value="' + window.Md.esc(f.adminNote || '') + '" /></div>'
          + '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">'
          + (f.problemDeleted ? '' : '<button class="btn btn-sm" data-fact="edit">修改题目/解析</button><button class="btn btn-sm btn-danger" data-fact="delete">删除题目</button>')
          + '<button class="btn btn-sm btn-ok" data-fact="resolve">标记已处理</button>'
          + '<button class="btn btn-sm" data-fact="ignore">忽略</button>'
          + (f.status !== 'open' ? '<button class="btn btn-sm" data-fact="reopen">重新打开</button>' : '')
          + '</div></div>';
      };

      window.__appealMap = {};
      window.__fbMap = {};
      d.items.forEach(function (f) { window.__fbMap[f.id] = f; if (f.submissionId) window.__appealMap[f.id] = f.submissionId; });
      wrap.innerHTML = d.items.length
        ? d.items.map(Item).join('')
        : '<div class="empty" style="padding:18px">暂无 AI 已审阅的反馈。</div>';

      wrap.querySelectorAll('.review-item').forEach(function (node) {
        node.querySelectorAll('[data-fact]').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            const note = (node.querySelector('.fb-note') || {}).value || '';
            try {
              const fb = (window.__fbMap || {})[node.dataset.fid];
              if (!fb) throw new Error('找不到这条反馈');
              if (btn.dataset.fact === 'edit') { await openProblemEditor(fb); return; }
              if (btn.dataset.fact === 'delete') {
                if (!window.confirm('确定删除 ' + fb.code + '？会同时清理每日一题、用户做题记录和帖子关联，且不可恢复。')) return;
                await window.API.post('/api/admin/problem/' + encodeURIComponent(fb.code) + '/delete', { feedbackId: fb.id, note: note || '管理员从反馈删除题目' });
                window.UI.toast('题目已删除', 'ok');
                loadFeedback();
                return;
              }
              if (btn.dataset.fact === 'override') {
                const raw = (node.querySelector('.ap-score') || {}).value;
                const sc = Number(raw);
                if (!Number.isFinite(sc) || sc < 0 || sc > 100) { window.UI.toast('填个 0-100 的分数', 'err'); return; }
                const fid = node.dataset.fid;
                const target = (window.__appealMap || {})[fid];
                if (!target) { window.UI.toast('找不到对应的提交记录', 'err'); return; }
                await window.API.post('/api/admin/submissions/override', { submissionId: target, score: sc, comment: note });
                window.UI.toast('已改判为 ' + sc + ' 分', 'ok');
                loadFeedback();
                return;
              }
              await window.API.post('/api/admin/feedback/' + node.dataset.fid, { action: btn.dataset.fact, note: note });
              window.UI.toast('已更新', 'ok');
              loadFeedback();
            } catch (e) { window.UI.toast(e.message, 'err'); }
          });
        });
      });
    } catch (e) {
      wrap.innerHTML = window.UI.empty('反馈加载失败', e.message);
    }
  }

  /* OCR 坏例：左原文 / 右改正，字符级 diff */
  function charDiff(a, b) {
    const A = Array.from(a).slice(0, 600), B = Array.from(b).slice(0, 600);
    const n = A.length, m = B.length;
    if (n * m > 250000) return { left: A.join(''), right: B.join('') };
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0, right = '', left = '';
    while (i < n && j < m) {
      if (A[i] === B[j]) { right += window.Md.esc(B[j]); left += window.Md.esc(A[i]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { left += '<del>' + window.Md.esc(A[i]) + '</del>'; i++; }
      else { right += '<ins>' + window.Md.esc(B[j]) + '</ins>'; j++; }
    }
    while (i < n) { left += '<del>' + window.Md.esc(A[i++]) + '</del>'; }
    while (j < m) { right += '<ins>' + window.Md.esc(B[j++]) + '</ins>'; }
    return { left, right };
  }

  async function loadOcrBadcases() {
    const wrap = document.getElementById('bcList');
    if (!wrap) return;
    try {
      const d = await window.API.get('/api/admin/ocr-badcases');
      const cnt = document.getElementById('bcCount');
      if (cnt) cnt.textContent = d.total + ' 条';
      if (!d.items.length) {
        wrap.innerHTML = '<div class="empty" style="padding:18px">还没有坏例。用户走 OCR 投稿并手动改错后，会自动记录下来。</div>';
        return;
      }
      wrap.innerHTML = d.items.slice(0, 30).map(function (c) {
        const diff = charDiff(String(c.raw || ''), String(c.final || ''));
        const rawShown = window.Md.esc(String(c.raw || '').replace(/\[low\]/g, '⟨').replace(/\[\/low\]/g, '⟩'))
          .replace(/⟨/g, '<span class="tag gold">').replace(/⟩/g, '</span>');
        return '<div class="bc-card" style="border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:12px">'
          + '<div class="small muted" style="display:flex;gap:8px;flex-wrap:wrap">'
          + '<span class="mono">' + window.Md.esc(c.id || '') + '</span>'
          + '<span class="tag">conf ' + (c.conf || 0) + '</span>'
          + '<span class="tag">' + window.Md.esc(c.variant || 'n/a') + '</span>'
          + (c.quality ? '<span class="tag">blur ' + c.quality.blur + ' / uneven ' + c.quality.uneven + '</span>' : '')
          + '<span>' + window.UI.fmtDate(c.at) + '</span></div>'
          + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px">'
          + '<div><div class="small muted">识别原文</div><div class="md" style="max-height:180px;overflow:auto;font-size:12.5px;white-space:pre-wrap">' + rawShown + '</div></div>'
          + '<div><div class="small muted">用户改正</div><div class="md" style="max-height:180px;overflow:auto;font-size:12.5px;white-space:pre-wrap">' + diff.right + '</div></div>'
          + '</div></div>';
      }).join('');
    } catch (e) {
      wrap.innerHTML = window.UI.empty('坏例加载失败', e.message);
    }
  }

  /* 用户提交记录：谁在什么时候交了哪道题、AI 给了多少分 */
  async function loadSubmissions() {
    const wrap = document.getElementById('subList');
    if (!wrap) return;
    try {
      const d = await window.API.get('/api/admin/submissions?limit=80');
      const cnt = document.getElementById('subCount');
      if (cnt) cnt.textContent = d.total + ' 条';
      if (!d.items.length) {
        wrap.innerHTML = '<div class="empty" style="padding:18px">还没有人交过题。</div>';
        return;
      }
      const vTag = function (v) {
        if (v === 'correct') return '<span class="tag gold">正确</span>';
        if (v === 'partial') return '<span class="tag">部分对</span>';
        if (v === 'wrong') return '<span class="tag">有错</span>';
        return '<span class="tag">未判定</span>';
      };
      wrap.innerHTML = d.items.map(function (s) {
        return '<div class="review-item" style="padding:12px 14px;margin-bottom:10px;border:1px solid var(--border,#dde);border-radius:8px">'
          + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
          + '<a class="mono" href="#/problem/' + s.code + '">' + s.code + '</a>'
          + vTag(s.verdict)
          + '<span class="tag">' + s.score + ' 分</span>'
          + '<span class="tag">' + (s.mode === 'answer' ? '仅答案' : '交过程') + '</span>'
          + (s.hasImage ? '<span class="tag">含图片</span>' : '')
          + '<span class="small muted">' + window.Md.esc(s.name || '用户') + ' · ' + window.UI.fmtDate(s.at) + '</span>'
          + '</div>'
          + '<div class="small muted" style="margin:6px 0">' + window.Md.inlineTex(s.title || '') + '</div>'
          + (s.comment ? '<div class="small" style="margin:4px 0"><b>评分意见：</b>' + window.Md.esc(s.comment) + '</div>' : '')
          + (s.errors && s.errors.length ? '<div class="small" style="margin:4px 0"><b>扣分点：</b>' + window.Md.esc(s.errors.slice(0, 3).join('；')) + '</div>' : '')
          + '<details style="margin-top:6px"><summary class="small muted">展开提交原文</summary>'
          + '<pre class="small" style="white-space:pre-wrap;margin:6px 0 0;padding:10px;background:var(--bg-soft,#f7f7fa);border-radius:6px">'
          + window.Md.esc(s.process || '（仅图片，无文字）') + '</pre></details>'
          + (s.judgedBy ? '<div class="small muted" style="margin-top:6px">阅卷：' + window.Md.esc(s.judgedBy) + '</div>' : '')
          + '</div>';
      }).join('');
    } catch (e) {
      wrap.innerHTML = window.UI.empty('提交记录加载失败', e.message);
    }
  }

  Views.admin = function (el) {
    if (!St.me) {
      el.innerHTML = '<div class="empty"><b>需要管理员登录</b>第一个注册的账号自动成为管理员。'
        + '<div style="margin-top:14px"><button class="btn btn-primary" id="adminLogin">登录</button></div></div>';
      document.getElementById('adminLogin').addEventListener('click', function () { window.UI.authModal('login'); });
      return;
    }
    if (St.me.role !== 'admin') {
      el.innerHTML = '<div class="empty"><b>你没有审核权限</b>当前账号是普通用户。题目审核由管理员负责。</div>';
      return;
    }

    el.innerHTML =
      '<div class="page-head"><div><h1>审核后台</h1>'
      + '<p class="sub">投稿必须在这里逐题核对后才能进入题库。审的是：题干是否完整、解答是否可复现、三维评分是否合理。</p></div>'
      + '<div class="head-actions"><span class="tag gold" id="pendingCount">待审 0</span></div></div>'
      + '<div id="pendingList"><div class="loading-row"><span class="spinner"></span>加载待审题目…</div></div>'

      + '<div class="card form-card" style="margin-top:22px">'
      + '<h3 style="margin:0 0 6px;font-size:15px">批量导入题目</h3>'
      + '<p class="small muted" style="margin:0 0 12px">粘贴 JSON 数组，每项字段：<code>title, statement, mainTag?, tags[], thinking, difficulty, calc, source, hints[], answer, solution</code>。导入即视为审核通过。</p>'
      + '<div class="field"><textarea id="importBox" rows="8" placeholder=\'[{"title":"…","statement":"求 $$\\\\lim_{x\\\\to 0}…$$","mainTag":"极限与连续","tags":["函数极限"],"thinking":6,"difficulty":6,"calc":5,"source":"…","hints":["…"],"answer":"…","solution":"…"}]\'></textarea></div>'
      + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
      + '<input type="file" id="importFile" accept=".json,application/json" style="display:none" />'
      + '<button class="btn" id="pickFile">选择 JSON 文件</button>'
      + '<button class="btn btn-primary" id="doImport">导入</button>'
      + '<button class="btn" id="exportBtn" title="导出题库、帖子与每日一题记录（不含账号密码）">导出全部数据</button>'
      + '<span class="small muted" id="importHint"></span></div>'
      + '</div>'

      + '<div class="card form-card" style="margin-top:22px">'
      + '<h3 style="margin:0 0 6px;font-size:15px">AI 答疑模型</h3>'
      + '<p class="small muted" style="margin:0 0 14px">填 OpenAI 兼容接口即可（DeepSeek 默认 <code>https://api.deepseek.com/v1</code>）。不填就使用内置的本地讲解模式，AI 对话与论坛回帖仍然可用。</p>'
      + '<div class="field-row">'
      + '<div class="field"><label>Base URL</label><input id="llmBase" placeholder="https://api.deepseek.com/v1" /></div>'
      + '<div class="field"><label>模型名</label><input id="llmModel" placeholder="deepseek-chat" /></div>'
      + '</div>'
      + '<div class="field"><label>API Key</label><input id="llmKey" type="password" placeholder="留空表示不改" /></div>'
      + '<div style="display:flex;gap:10px;align-items:center"><button class="btn btn-primary" id="saveLLM">保存</button>'
      + '<span class="small muted" id="llmStatus"></span></div>'
      + '</div>'

      + '<div class="card form-card" style="margin-top:22px">'
      + '<h3 style="margin:0 0 6px;font-size:15px">识图模型（全站共用）</h3>'
      + '<p class="small muted" style="margin:0 0 14px">给全站用户读题图用（投稿识图、图片判卷）。填一个支持图片的模型，如智谱 <code>glm-4v-flash</code>（免费）。不填则用户只能用本地 OCR 或自己的 Key。Key 只存服务端，不会下发给访客。</p>'
      + '<div class="field-row">'
      + '<div class="field"><label>Base URL</label><input id="vBase" placeholder="https://open.bigmodel.cn/api/paas/v4" /></div>'
      + '<div class="field"><label>模型名</label><input id="vModel" placeholder="glm-4v-flash" /></div>'
      + '</div>'
      + '<div class="field"><label>API Key</label><input id="vKey" type="password" placeholder="留空表示不改" /></div>'
      + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn btn-primary" id="saveVision">保存</button>'
      + '<button class="btn" id="clearVision">清空识图 Key</button>'
      + '<span class="small muted" id="visionStatus"></span></div>'
      + '</div>'

      + '<div class="card form-card" style="margin-top:22px">'
      + '<h3 style="margin:0 0 10px;font-size:15px">题目反馈 <span class="tag gold" id="fbCount">0 条待处理</span></h3>'
      + '<p class="small muted" style="margin:0 0 14px">用户反馈先由 AI 审阅归类，结论与建议随原文一并转到这里。只有 AI 审阅完成的反馈才会出现。</p>'
      + '<div id="fbReviewing" class="small muted" style="margin-bottom:10px"></div>'
      + '<div id="feedbackList" class="small muted">加载中…</div>'
      + '</div>'

      + '<div class="card form-card" style="margin-top:22px">'
      + '<h3 style="margin:0 0 10px;font-size:15px">用户提交记录 <span class="tag" id="subCount">0 条</span></h3>'
      + '<p class="small muted" style="margin:0 0 14px">谁在什么时候交了哪道题、AI 给了多少分。点开看提交原文，用来发现普遍性错误或可疑评分。</p>'
      + '<div id="subList" class="small muted">加载中…</div>'
      + '</div>'

      + '<div class="card form-card" style="margin-top:22px">'
      + '<h3 style="margin:0 0 10px;font-size:15px">OCR 坏例 <span class="tag" id="bcCount">0 条</span></h3>'
      + '<p class="small muted" style="margin:0 0 14px">左边是识别原文（<span class="tag gold">黄色</span>为低置信度片段），右边是用户改正后的版本，标红的是被改写的字符。用来判断该改预处理还是该改提示词。</p>'
      + '<div id="bcList" class="small muted">加载中…</div>'
      + '</div>'

      + '<div class="card form-card" style="margin-top:22px">'
      + '<h3 style="margin:0 0 10px;font-size:15px">已驳回</h3><div id="rejectedList" class="small muted">加载中…</div>'
      + '</div>';

    loadPending();
    loadRejected();
    loadLLM();
    loadFeedback();
    loadSubmissions();
    loadOcrBadcases();

    /* 批量导入 */
    const fileInput = document.getElementById('importFile');
    document.getElementById('pickFile').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      const f = fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = function () {
        document.getElementById('importBox').value = String(reader.result || '');
        const hint = document.getElementById('importHint');
        hint.textContent = '已读入 ' + f.name;
      };
      reader.readAsText(f, 'utf-8');
    });

    document.getElementById('exportBtn').addEventListener('click', function () {
      window.location.href = '/api/admin/export';
      window.UI.toast('已开始下载备份', 'ok');
    });

    document.getElementById('doImport').addEventListener('click', async function () {
      const btn = this;
      const hint = document.getElementById('importHint');
      let list;
      try {
        list = JSON.parse(document.getElementById('importBox').value);
      } catch (e) {
        hint.textContent = 'JSON 解析失败：' + e.message;
        return;
      }
      if (!Array.isArray(list)) { hint.textContent = '需要一个数组'; return; }
      btn.disabled = true;
      hint.textContent = '导入中…';
      try {
        const res = await window.API.post('/api/admin/import', { problems: list });
        hint.textContent = '成功导入 ' + res.added.length + ' 题' + (res.skipped.length ? '，跳过 ' + res.skipped.length + ' 条（缺标题或题干）' : '');
        document.getElementById('importBox').value = '';
        window.UI.toast('导入完成：' + res.added.join('、'), 'ok');
        loadPending();
      } catch (e) {
        hint.textContent = e.message;
      } finally {
        btn.disabled = false;
      }
    });

    /* LLM 设置 */
    document.getElementById('saveLLM').addEventListener('click', async function () {
      const btn = this;
      btn.disabled = true;
      try {
        await window.API.post('/api/admin/llm', {
          baseUrl: document.getElementById('llmBase').value.trim(),
          model: document.getElementById('llmModel').value.trim(),
          apiKey: document.getElementById('llmKey').value.trim()
        });
        document.getElementById('llmKey').value = '';
        window.UI.toast('已保存模型设置', 'ok');
        loadLLM();
      } catch (e) {
        window.UI.toast(e.message, 'err');
      } finally {
        btn.disabled = false;
      }
    });

    async function loadLLM() {
      try {
        const data = await window.API.get('/api/admin/llm');
        document.getElementById('llmBase').value = data.llm.baseUrl || '';
        document.getElementById('llmModel').value = data.llm.model || '';
        document.getElementById('llmStatus').innerHTML = data.llm.configured
          ? '<span style="color:'+window.UI.tone('teal')+'">已配置 · ' + window.Md.esc(data.llm.model) + ' · key ' + window.Md.esc(data.llm.keyHint) + '</span>'
          : '<span style="color:'+window.UI.tone('warn')+'">未配置，使用本地讲解模式</span>';
        const v = data.vision || {};
        const vb = document.getElementById('vBase'), vm = document.getElementById('vModel'), vs = document.getElementById('visionStatus');
        if (vb) vb.value = v.baseUrl || '';
        if (vm) vm.value = v.model || '';
        if (vs) vs.innerHTML = v.configured
          ? '<span style="color:'+window.UI.tone('teal')+'">已配置 · ' + window.Md.esc(v.model || '') + ' · key ' + window.Md.esc(v.keyHint || '') + '</span>'
          : '<span style="color:'+window.UI.tone('warn')+'">未配置，全站识图不可用</span>';
      } catch (e) {}
    }

    /* 识图模型保存 / 清空 */
    const saveVisionBtn = document.getElementById('saveVision');
    if (saveVisionBtn) saveVisionBtn.addEventListener('click', async function () {
      const btn = this; btn.disabled = true;
      try {
        await window.API.post('/api/admin/llm', {
          target: 'vision',
          baseUrl: document.getElementById('vBase').value.trim(),
          model: document.getElementById('vModel').value.trim(),
          apiKey: document.getElementById('vKey').value.trim()
        });
        document.getElementById('vKey').value = '';
        window.UI.toast('识图模型已保存', 'ok');
        loadLLM();
      } catch (e) { window.UI.toast(e.message, 'err'); }
      finally { btn.disabled = false; }
    });
    const clearVisionBtn = document.getElementById('clearVision');
    if (clearVisionBtn) clearVisionBtn.addEventListener('click', async function () {
      try {
        await window.API.post('/api/admin/llm', { target: 'vision', clearKey: true });
        window.UI.toast('识图 Key 已清空', 'ok');
        loadLLM();
      } catch (e) { window.UI.toast(e.message, 'err'); }
    });

    async function loadRejected() {
      try {
        const data = await window.API.get('/api/admin/rejected');
        const box = document.getElementById('rejectedList');
        box.innerHTML = data.items.length
          ? data.items.map(function (p) {
            return '<div class="related-item"><span class="code">' + p.code + '</span><span class="t">' + window.Md.esc(p.title) + '</span>'
              + '<span class="small" style="color:'+window.UI.tone('err')+'">' + window.Md.esc(p.rejectReason || '') + '</span></div>';
          }).join('')
          : '没有驳回记录';
      } catch (e) {}
    }

    async function loadPending() {
      const wrap = document.getElementById('pendingList');
      try {
        const data = await window.API.get('/api/admin/pending');
        document.getElementById('pendingCount').textContent = '待审 ' + data.items.length;
        if (!data.items.length) {
          wrap.innerHTML = '<div class="empty"><b>没有待审核的题目</b>投稿通过这里审核后才会出现在题库里。</div>';
          return;
        }
        wrap.innerHTML = data.items.map(function (p) {
          return '<div class="review-item" data-code="' + p.code + '">'
            + '<div class="review-head"><span class="problem-code-badge">' + p.code + '</span>'
            + '<h3>' + window.Md.esc(p.title) + '</h3>'
            + '<span class="small muted">' + window.Md.esc(p.authorName || '') + ' · ' + window.UI.timeAgo(p.createdAt) + '</span></div>'
            + '<div class="tags">' + window.UI.tagBadges(p, { showKind: true }) + '</div>'
            + '<div class="review-grid" style="margin-top:12px">'
            + scoreInput('思维量', p.thinking) + scoreInput('难度', p.difficulty) + scoreInput('计算量', p.calc)
            + '<div class="field"><label>主标签</label><select data-f="mainTag">' + window.UI.mainTagOptions(p.mainTag) + '</select></div>'
            + '<div class="field"><label>子标签（逗号分隔）</label><input data-f="tags" value="' + window.Md.esc((p.tags || []).join(', ')) + '" /></div>'
            + '</div>'
            + '<div class="review-statement md" data-md="stmt">' + window.Md.toHtml(p.statement) + '</div>'
            + (p.solution ? '<details style="margin:8px 0"><summary class="small muted" style="cursor:pointer">展开解析</summary><div class="review-statement md" data-md="sol">' + window.Md.toHtml(p.solution) + '</div></details>' : '<div class="small" style="color:'+window.UI.tone('err')+'">没填解析</div>')
            + '<div class="review-actions">'
            + '<button class="btn btn-ok btn-sm" data-act="approve">通过入库</button>'
            + '<input class="input" style="min-width:220px;flex:1" placeholder="驳回原因（驳回时填）" data-f="reason" />'
            + '<button class="btn btn-danger btn-sm" data-act="reject">驳回</button>'
            + '</div></div>';
        }).join('');

        wrap.querySelectorAll('.review-item').forEach(function (item) {
          window.Md.renderMath(item);
          const code = item.dataset.code;
          const collect = function () {
            const patch = {};
            item.querySelectorAll('[data-f]').forEach(function (input) {
              const f = input.dataset.f;
              if (f === 'tags') patch.tags = input.value.split(/[,，、\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
              else if (f === 'mainTag') patch.mainTag = input.value;
              else if (f === 'reason') patch.reason = input.value;
              else if (f === '思维量') patch.thinking = Number(input.value);
              else if (f === '难度') patch.difficulty = Number(input.value);
              else if (f === '计算量') patch.calc = Number(input.value);
            });
            return patch;
          };
          item.querySelector('[data-act="approve"]').addEventListener('click', async function () {
            const patch = collect();
            delete patch.reason;
            try {
              await window.API.post('/api/admin/review', { code: code, action: 'approve', patch: patch });
              item.remove();
              window.UI.toast(code + ' 已入库', 'ok');
              const cnt = document.getElementById('pendingCount');
              if (cnt) cnt.textContent = '待审 ' + document.querySelectorAll('.review-item').length;
            } catch (e) { window.UI.toast(e.message, 'err'); }
          });
          item.querySelector('[data-act="reject"]').addEventListener('click', async function () {
            const patch = collect();
            if (!patch.reason) { window.UI.toast('请填写驳回原因', 'err'); return; }
            try {
              await window.API.post('/api/admin/review', { code: code, action: 'reject', reason: patch.reason });
              item.remove();
              window.UI.toast(code + ' 已驳回', 'ok');
              loadRejected();
            } catch (e) { window.UI.toast(e.message, 'err'); }
          });
        });
      } catch (e) {
        wrap.innerHTML = window.UI.empty('加载失败', e.message);
      }
    }
  };
})();
