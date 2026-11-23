/* AI 出题 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};
  const St = window.API.State;

  let spec = { tags: [], difficulty: 6, calc: 5, style: '', note: '' };
  let last = null;
  let busy = false;

  const STYLES = ['不限', '计算题', '证明题', '概念辨析', '应用题'];

  function tagChips() {
    const tags = St.tags || [];
    if (!tags.length) return '<span class="small muted">题库暂无标签，可直接生成</span>';
    return tags.map(function (t) {
      const on = spec.tags.indexOf(t.name) >= 0;
      return '<button type="button" class="chip' + (on ? ' active' : '') + '" data-tag="' + window.Md.esc(t.name) + '">'
        + window.Md.esc(t.name) + '<span class="n">' + t.count + '</span></button>';
    }).join('');
  }

  function bindTags(el) {
    el.querySelectorAll('#genTags [data-tag]').forEach(function (b) {
      b.addEventListener('click', function () {
        const t = b.dataset.tag;
        const i = spec.tags.indexOf(t);
        if (i >= 0) spec.tags.splice(i, 1);
        else {
          if (spec.tags.length >= 2) {
            window.UI.toast('最多选 2 个考点，再多容易出跑偏');
            return;
          }
          spec.tags.push(t);
        }
        b.classList.toggle('active');
      });
    });
  }

  function renderForm() {
    return '<form class="card form-card" id="genForm">'
      + '<div class="form-section-title">知识点</div>'
      + '<div class="chip-scroll" id="genTags">' + tagChips() + '</div>'
      + '<div class="form-section-title">难度与计算量</div>'
      + row('难度', 'gDiff', spec.difficulty)
      + row('计算量', 'gCalc', spec.calc)
      + '<div class="form-section-title">题型与附加要求</div>'
      + '<div class="field"><select id="gStyle">'
      + STYLES.map(function (s) {
        return '<option value="' + (s === '不限' ? '' : s) + '"' + (spec.style === (s === '不限' ? '' : s) ? ' selected' : '') + '>' + s + '</option>';
      }).join('')
      + '</select></div>'
      + '<div class="field"><input id="gNote" maxlength="160" placeholder="可选，例如：含参数讨论 / 用到两次分部积分 / 与定积分结合" value="' + window.Md.esc(spec.note) + '" /></div>'
      + '<div class="gen-actions">'
      + '<button class="btn btn-primary" type="submit" id="genBtn">生成一道题</button>'
      + '<span class="small muted" id="genHint">用当前可用的 AI 通道生成，结果需要你确认后再入库</span>'
      + '</div></form>';

    function row(label, id, val) {
      return '<div class="range-row"><span class="lab">' + label + '</span>'
        + '<input type="range" id="' + id + '" min="1" max="10" step="1" value="' + val + '" />'
        + '<span class="val" id="' + id + 'Val">' + val + '</span></div>';
    }
  }

  function renderResult() {
    const box = document.getElementById('genResult');
    if (!box) return;
    if (busy) {
      box.innerHTML = '<div class="card result-card"><div class="result-head"><span class="spinner"></span>'
        + '<b>正在出题…</b><span class="small muted">免费通道排队时可能要十几秒</span></div></div>';
      return;
    }
    if (!last) {
      box.innerHTML = '<div class="empty"><b>还没有生成结果</b>选好考点和难度，点「生成一道题」。</div>';
      return;
    }

    const p = last;
    box.innerHTML = '<div class="card result-card" id="genCard">'
      + '<div class="result-head"><b>生成结果</b>'
      + '<span class="tag gray">' + window.Md.esc(p.modelLabel || 'AI') + '</span></div>'
      + '<div class="gen-warn">AI 写的是草稿，不是标准答案。反常积分、含参数题、分部积分的边界项最容易算错，入库前请自己验算一遍。</div>'
      + '<div class="field"><label>标题</label><input name="title" value="' + window.Md.esc(p.title) + '" maxlength="120" /></div>'
      + '<div class="field"><label>题干</label><textarea name="statement" rows="5">' + window.Md.esc(p.statement) + '</textarea></div>'
      + '<div class="preview md" id="genPreview"></div>'
      + '<div class="field-row">'
      + '<div class="field"><label>考点标签（逗号分隔）</label><input name="tags" value="' + window.Md.esc((p.tags || []).join(', ')) + '" /></div>'
      + '<div class="field"><label>来源</label><input name="source" value="' + window.Md.esc(p.source || 'AI 出题 · 待人工审核') + '" /></div>'
      + '</div>'
      + '<div class="field-row three">'
      + '<div class="field"><label>思维量</label><input name="thinking" type="number" min="1" max="10" value="' + p.thinking + '" /></div>'
      + '<div class="field"><label>难度</label><input name="difficulty" type="number" min="1" max="10" value="' + p.difficulty + '" /></div>'
      + '<div class="field"><label>计算量</label><input name="calc" type="number" min="1" max="10" value="' + p.calc + '" /></div>'
      + '</div>'
      + '<div class="field"><label>分层提示（每行一条）</label><textarea name="hints" rows="2">' + window.Md.esc((p.hints || []).join('\n')) + '</textarea></div>'
      + '<div class="field"><label>答案</label><input name="answer" value="' + window.Md.esc(p.answer || '') + '" /></div>'
      + '<div class="field"><label>解析</label><textarea name="solution" rows="9">' + window.Md.esc(p.solution || '') + '</textarea></div>'
      + '<div class="gen-actions">'
      + '<button class="btn btn-primary" id="genSubmit">提交审核</button>'
      + (St.me && St.me.role === 'admin' ? '<button class="btn btn-ok" id="genApprove">直接入库</button>' : '')
      + '<button class="btn" id="genAgain">换一道</button>'
      + '<span class="small muted" id="genMsg"></span>'
      + '</div></div>';

    const preview = document.getElementById('genPreview');
    window.Md.render(preview, p.statement || '');

    const stmt = box.querySelector('textarea[name="statement"]');
    stmt.addEventListener('input', function () {
      window.Md.render(preview, stmt.value);
    });

    document.getElementById('genSubmit').addEventListener('click', function () {
      submitGenerated(false);
    });
    const approve = document.getElementById('genApprove');
    if (approve) approve.addEventListener('click', function () { submitGenerated(true); });
    document.getElementById('genAgain').addEventListener('click', startGenerate);
  }

  function collect() {
    const card = document.getElementById('genCard');
    if (!card) return null;
    const v = function (sel) { const el = card.querySelector(sel); return el ? el.value : ''; };
    return {
      title: v('[name="title"]').trim(),
      statement: v('[name="statement"]').trim(),
      tags: v('[name="tags"]').split(/[,，、\s]+/).map(function (s) { return s.trim(); }).filter(Boolean),
      source: v('[name="source"]').trim(),
      thinking: Number(v('[name="thinking"]')),
      difficulty: Number(v('[name="difficulty"]')),
      calc: Number(v('[name="calc"]')),
      hints: v('[name="hints"]').split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
      answer: v('[name="answer"]').trim(),
      solution: v('[name="solution"]').trim()
    };
  }

  async function submitGenerated(autoApprove) {
    if (!window.UI.requireLogin(null, '登录后才能把题入库')) return;
    const data = collect();
    if (!data || !data.title || !data.statement) { window.UI.toast('标题和题干不能为空', 'err'); return; }
    const msg = document.getElementById('genMsg');
    const btn = document.getElementById('genSubmit');
    if (btn) btn.disabled = true;
    if (msg) msg.textContent = '提交中…';
    try {
      const res = await window.API.post('/api/submit', data);
      if (autoApprove) {
        await window.API.post('/api/admin/review', { code: res.code, action: 'approve', patch: {} });
        window.UI.toast(res.code + ' 已入库', 'ok');
        location.hash = '#/problem/' + res.code;
        return;
      }
      window.UI.toast('已提交 ' + res.code + '，等管理员审核', 'ok');
      if (msg) msg.innerHTML = '已提交 <a href="#/my">我的投稿</a>';
    } catch (e) {
      window.UI.toast(e.message, 'err');
      if (msg) msg.textContent = '';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function startGenerate() {
    if (busy) return;
    busy = true;
    last = null;
    renderResult();

    const own = window.Chat && window.Chat.llmConfig ? window.Chat.llmConfig() : null;
    const siteReady = !!(St.llm && St.llm.configured);

    try {
      let p;
      if (own || siteReady || !window.FreeLLM) {
        const res = await window.API.post('/api/ai/generate', {
          tags: spec.tags, difficulty: spec.difficulty, calc: spec.calc,
          style: spec.style, note: spec.note, llm: own || undefined
        });
        p = res.problem;
        p.modelLabel = res.model.mode === 'free'
          ? '免费通道 · ' + res.model.provider
          : (res.model.mode === 'user-key' ? '我的 Key' : '站点模型');
      } else {
        // 浏览器直连免费通道，用访客自己的 IP 额度
        const prompt = await window.API.post('/api/ai/prompt', {
          tags: spec.tags, difficulty: spec.difficulty, calc: spec.calc,
          style: spec.style, note: spec.note
        });
        const text = await window.FreeLLM.complete(prompt.messages);
        const parsed = await window.API.post('/api/ai/parse', { text });
        p = parsed.problem;
        p.modelLabel = '免费通道 · 本机直连';
      }
      last = p;
      busy = false;
      renderResult();
      window.UI.toast('出好了，核对一下再入库', 'ok');
    } catch (e) {
      busy = false;
      renderResult();
      const box = document.getElementById('genResult');
      const isLimit = e.code === 'FREE_LIMIT' || /冷却|45/.test(e.message || '');
      if (box) {
        box.innerHTML = '<div class="card result-card"><div class="result-head"><b>没生成出来</b></div>'
          + '<div class="small muted" style="line-height:1.9">' + window.Md.esc(e.message || '未知错误')
          + (isLimit
            ? '<br/>免费通道对同一网络限制 45 秒一次。等半分钟再点，或者点右下「模型」填自己的 Key（无限次）。'
            : '<br/>可以换个人少的时间、少选几个考点，或点右下「模型」填自己的 Key。')
          + '</div><div class="gen-actions"><button class="btn" id="retryGen">再试一次</button></div></div>';
        document.getElementById('retryGen').addEventListener('click', startGenerate);
      }
    }
  }

  Views.generate = function (el) {
    spec = { tags: [], difficulty: 6, calc: 5, style: '', note: '' };
    last = null;
    busy = false;

    el.innerHTML =
      '<div class="page-head"><div><h1>让 AI 出一道题</h1>'
      + '<p class="sub">选知识点和难度，AI 生成题干、答案和解析。生成的题不会自动进题库——需要你和管理员核对后提交审核，和人工投稿走同一条流程。</p></div></div>'
      + '<div class="gen-layout">'
      + '<div id="genFormBox">' + renderForm() + '</div>'
      + '<aside>'
      + '<div class="card side-card"><h3>出题建议</h3><div class="xp-rule">'
      + '· 考点选 1-2 个最准，选太多会出成四不像<br/>'
      + '· 难度 7 以上建议备注「不要超纲」<br/>'
      + '· 生成结果里的答案必须自己验算，AI 会算错<br/>'
      + '· 免费通道每小时最多 12 次</div></div>'
      + '<div class="card side-card"><h3>当前通道</h3><div class="xp-rule" id="genChannel">—</div></div>'
      + '</aside></div>'
      + '<div id="genResult" style="margin-top:18px"></div>';

    const channel = document.getElementById('genChannel');
    const hasKey = St.llm && St.llm.configured;
    channel.textContent = hasKey ? '站点模型可直连' : '免费通道 · 本机直连（同一网络 45 秒一次）';

    renderResult();

    el.querySelector('#genForm').addEventListener('submit', function (e) {
      e.preventDefault();
      spec.difficulty = Number(document.getElementById('gDiff').value);
      spec.calc = Number(document.getElementById('gCalc').value);
      spec.style = document.getElementById('gStyle').value;
      spec.note = document.getElementById('gNote').value.trim();
      startGenerate();
    });

    bindTags(el);

    if (!St.tags || !St.tags.length) {
      window.API.get('/api/problems?size=1').then(function (d) {
        St.tags = d.tags || [];
        const box = el.querySelector('#genTags');
        if (box) {
          box.innerHTML = tagChips();
          bindTags(el);
        }
      }).catch(function () {});
    }

    [['gDiff', '难度'], ['gCalc', '计算量']].forEach(function (pair) {
      const input = document.getElementById(pair[0]);
      input.addEventListener('input', function () {
        document.getElementById(pair[0] + 'Val').textContent = input.value;
      });
    });
  };
})();
