/* 审核后台 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};
  const St = window.API.State;

  function scoreInput(name, value) {
    return '<div class="field"><label>' + name + '</label><input type="number" min="1" max="10" value="' + value + '" data-f="' + name + '" /></div>';
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
      + '<p class="small muted" style="margin:0 0 12px">粘贴 JSON 数组，每项字段：<code>title, statement, tags[], thinking, difficulty, calc, source, hints[], answer, solution</code>。导入即视为审核通过。</p>'
      + '<div class="field"><textarea id="importBox" rows="8" placeholder=\'[{"title":"…","statement":"求 $$\\\\lim_{x\\\\to 0}…$$","tags":["极限"],"thinking":6,"difficulty":6,"calc":5,"source":"…","hints":["…"],"answer":"…","solution":"…"}]\'></textarea></div>'
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
      + '<h3 style="margin:0 0 10px;font-size:15px">已驳回</h3><div id="rejectedList" class="small muted">加载中…</div>'
      + '</div>';

    loadPending();
    loadRejected();
    loadLLM();

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
          ? '<span style="color:#9df0e0">已配置 · ' + window.Md.esc(data.llm.model) + ' · key ' + window.Md.esc(data.llm.keyHint) + '</span>'
          : '<span style="color:#ffd9a3">未配置，使用本地讲解模式</span>';
      } catch (e) {}
    }

    async function loadRejected() {
      try {
        const data = await window.API.get('/api/admin/rejected');
        const box = document.getElementById('rejectedList');
        box.innerHTML = data.items.length
          ? data.items.map(function (p) {
            return '<div class="related-item"><span class="code">' + p.code + '</span><span class="t">' + window.Md.esc(p.title) + '</span>'
              + '<span class="small" style="color:#ff9b9b">' + window.Md.esc(p.rejectReason || '') + '</span></div>';
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
            + '<div class="tags">' + (p.tags || []).map(function (t) { return '<span class="tag">' + window.Md.esc(t) + '</span>'; }).join('') + '</div>'
            + '<div class="review-grid" style="margin-top:12px">'
            + scoreInput('思维量', p.thinking) + scoreInput('难度', p.difficulty) + scoreInput('计算量', p.calc)
            + '<div class="field"><label>考点标签（逗号分隔）</label><input data-f="tags" value="' + window.Md.esc((p.tags || []).join(', ')) + '" /></div>'
            + '</div>'
            + '<div class="review-statement md" data-md="stmt">' + window.Md.toHtml(p.statement) + '</div>'
            + (p.solution ? '<details style="margin:8px 0"><summary class="small muted" style="cursor:pointer">展开解析</summary><div class="review-statement md" data-md="sol">' + window.Md.toHtml(p.solution) + '</div></details>' : '<div class="small" style="color:#ff9b9b">没填解析</div>')
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
