/* AI 答疑：仿 DeepSeek 对话界面 */
(function () {
  'use strict';

  const KEY = 'mv_chats_v1';
  const LLM_KEY = 'mv_llm_v1';

  function loadLlmCfg() {
    return window.UI && window.UI.llmConfig ? window.UI.llmConfig() : null;
  }

  function modeText(evt) {
    if (!evt || evt.mode === 'local') return '本地讲解';
    if (evt.mode === 'free') return '免费通道 · ' + (evt.provider || 'Pollinations');
    if (evt.mode === 'user-key') return '我的 Key · ' + (evt.model || '');
    return '站点模型 · ' + (evt.model || '');
  }
  let shell = null;
  let sessions = [];
  let activeId = null;
  let streaming = false;
  let expertOn = true;
  let ctx = { problemCode: '', title: '', statement: '' };

  function loadSessions() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }

  function persist() {
    try {
      sessions = sessions.slice(0, 40);
      localStorage.setItem(KEY, JSON.stringify(sessions));
    } catch (e) {}
  }

  function makeSession(problemCode, title) {
    const s = {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: title ? clip(title, 22) : '新对话',
      problemCode: problemCode || '',
      messages: [],
      updatedAt: Date.now()
    };
    sessions.unshift(s);
    activeId = s.id;
    persist();
    return s;
  }

  function active() { return sessions.find(function (s) { return s.id === activeId; }); }

  function clip(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  /* ---------------------------------------------------------- 渲染 */

  function renderConvList() {
    const list = document.getElementById('convList');
    if (!list) return;
    list.innerHTML = sessions.map(function (s) {
      return '<div class="ai-conv' + (s.id === activeId ? ' active' : '') + '" data-id="' + s.id + '">'
        + '<span class="t">' + window.Md.esc(s.title) + '</span>'
        + '<button class="del" data-del="' + s.id + '" title="删除">×</button></div>';
    }).join('') || '<div class="small muted" style="padding:10px">还没有对话</div>';

    list.querySelectorAll('.ai-conv').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('[data-del]')) return;
        switchTo(row.dataset.id);
      });
    });
    list.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        const id = b.dataset.del;
        sessions = sessions.filter(function (s) { return s.id !== id; });
        if (activeId === id) {
          activeId = sessions[0] ? sessions[0].id : null;
          if (!activeId) makeSession('', '');
        }
        persist();
        renderConvList();
        renderThread();
      });
    });
  }

  function renderThread() {
    const box = document.getElementById('aiContent');
    if (!box) return;
    const s = active();
    if (!s) { box.innerHTML = ''; return; }

    document.getElementById('aiTitle').textContent = s.title;
    const chip = document.getElementById('ctxChip');
    if (s.problemCode) {
      chip.style.display = '';
      chip.innerHTML = '<span class="mono" style="font-size:11px;color:#9dc0ff">' + window.Md.esc(s.problemCode) + '</span>'
        + '<span style="color:var(--muted)">已带入题干</span>';
    } else {
      chip.style.display = 'none';
    }

    if (!s.messages.length) {
      const sugs = s.problemCode
        ? ['这道题第一步该干什么？', '为什么可以这样变形？', '给我一个不剧透答案的提示', '这题和哪类题是一套的？']
        : ['讲讲等价无穷小什么时候不能用', '洛必达和泰勒展开怎么选？', '中值定理题怎么找辅助函数？', '定积分有哪些常用技巧？'];
      box.innerHTML =
        '<div class="ai-welcome">'
        + '<div class="glyph">∫</div>'
        + '<h2>我是高数助教</h2>'
        + '<p>' + (s.problemCode ? '已读入题目 ' + window.Md.esc(s.problemCode) + '，可以直接问卡点' : '不会的题、想不通的步骤，直接问我') + '</p>'
        + '<div class="ai-sugs">' + sugs.map(function (t) {
          return '<div class="ai-sug" data-sug="' + window.Md.esc(t) + '">' + window.Md.esc(t) + '</div>';
        }).join('') + '</div></div>';
      box.querySelectorAll('[data-sug]').forEach(function (b) {
        b.addEventListener('click', function () { send(b.dataset.sug); });
      });
      return;
    }

    box.innerHTML = '<div class="ai-thread" id="aiThread"></div>';
    const thread = document.getElementById('aiThread');
    s.messages.forEach(function (m) { thread.appendChild(msgEl(m)); });
    scrollBottom();
  }

  function msgEl(m) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (m.role === 'assistant' ? 'assistant' : 'user');
    const me = window.API.State.me;
    const who = m.role === 'assistant'
      ? '<span class="who">∫</span>'
      : '<span class="who">' + window.Md.esc((me && me.name ? me.name.slice(0, 1) : '我')) + '</span>';
    wrap.innerHTML = who
      + '<div class="msg-body"><div class="msg-name">' + (m.role === 'assistant' ? '高数助教' : '你') + '</div>'
      + '<div class="bubble-wrap"></div>'
      + '<div class="msg-actions"></div></div>';
    const target = wrap.querySelector('.bubble-wrap');

    if (m.role === 'user') {
      const b = document.createElement('div');
      b.className = 'bubble';
      window.Md.render(b, m.content);
      target.appendChild(b);
    } else {
      const d = document.createElement('div');
      d.className = 'md';
      if (m.content) {
        window.Md.render(d, m.content);
      } else {
        d.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
      }
      target.appendChild(d);

      const acts = wrap.querySelector('.msg-actions');
      acts.innerHTML = '<button class="icon-btn" data-copy="1">复制</button>'
        + '<button class="icon-btn" data-retry="1">重新回答</button>';
      acts.querySelector('[data-copy]').addEventListener('click', function () {
        navigator.clipboard.writeText(m.content || '').then(function () {
          window.UI.toast('已复制', 'ok');
        }).catch(function () { window.UI.toast('复制失败', 'err'); });
      });
      acts.querySelector('[data-retry]').addEventListener('click', function () {
        if (streaming) return;
        const s = active();
        if (!s) return;
        // 找到这条消息之前的内容，重新生成
        const idx = s.messages.indexOf(m);
        s.messages = s.messages.slice(0, idx);
        renderThread();
        stream();
      });
    }
    return wrap;
  }

  function scrollBottom(force) {
    const sc = document.getElementById('aiScroll');
    if (!sc) return;
    const near = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 220;
    if (force || near) sc.scrollTop = sc.scrollHeight;
  }

  function switchTo(id) {
    if (streaming) { window.UI.toast('正在回答，稍等一下'); return; }
    activeId = id;
    const s = active();
    if (s) ctx.problemCode = s.problemCode || '';
    renderConvList();
    renderThread();
  }

  /* ---------------------------------------------------------- 发送 */

  async function send(text) {
    if (streaming) return;
    const s = active();
    if (!s) return;
    const content = String(text || '').trim();
    if (!content) return;

    s.messages.push({ role: 'user', content: content });
    if (s.messages.length === 1) {
      s.title = clip(content, 22);
      const t = document.getElementById('aiTitle');
      if (t) t.textContent = s.title;
    }
    s.updatedAt = Date.now();
    persist();

    renderThread();
    renderConvList();
    const thread = document.getElementById('aiThread');
    if (thread) {
      thread.appendChild(msgEl({ role: 'assistant', content: '' }));
      scrollBottom(true);
    }
    await stream();
  }

  function setModeLabel(text, color) {
    const ml = document.getElementById('modeLabel');
    if (!ml) return;
    ml.textContent = text;
    ml.style.color = color || '#3d4756';
  }

  function setStatus(text) {
    const nameEl = document.querySelector('.msg.assistant:last-child .msg-name');
    if (nameEl) nameEl.textContent = text;
  }

  async function stream() {
    const s = active();
    if (!s) return;
    const sendBtn = document.getElementById('aiSend');
    streaming = true;
    if (sendBtn) sendBtn.disabled = true;

    const thread = document.getElementById('aiThread');
    const last = thread ? thread.querySelector('.msg.assistant:last-child .md') : null;
    let buffer = '';
    let lastRender = 0;
    let lastLen = 0;

    const push = function (text) {
      buffer += text;
      const now = Date.now();
      if (now - lastRender > 55 || buffer.length - lastLen > 24) {
        lastRender = now;
        lastLen = buffer.length;
        if (last) window.Md.render(last, buffer);
        scrollBottom();
      }
    };

    const finish = function () {
      if (!buffer.trim()) buffer = '这条我没想出合适的答法。换个问法，或者把卡住的那一步贴给我。';
      s.messages.push({ role: 'assistant', content: buffer });
      s.updatedAt = Date.now();
      persist();
      if (last) {
        window.Md.render(last, buffer);
        const nameEl = last.closest('.msg').querySelector('.msg-name');
        if (nameEl) {
          const mode = document.getElementById('modeLabel');
          nameEl.textContent = '高数助教' + (mode && mode.textContent.indexOf('本地') >= 0 ? ' · 本地讲解' : '');
        }
      }
      scrollBottom();
    };

    /* 服务端通道（站点 Key / 自带 Key / 本地讲解） */
    const runServer = async function (extra) {
      const body = Object.assign({
        messages: s.messages.slice(-14),
        problemCode: s.problemCode || ctx.problemCode || '',
        llm: loadLlmCfg() || undefined,
        expert: expertOn
      }, extra || {});

      const resp = await fetch(window.API.url('/api/ai/chat'), {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, window.API.authHeaders()),
        credentials: window.API.sameOrigin() ? 'include' : 'omit',
        cache: 'no-store',
        body: JSON.stringify(body)
      });
      if (!resp.ok || !resp.body) {
        let msg = 'AI 服务不可用（' + resp.status + '）';
        try { const j = await resp.json(); if (j.error) msg = j.error; } catch (e) {}
        throw new Error(msg);
      }

      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find(function (l) { return l.startsWith('data: '); });
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line.slice(6)); } catch (e) { continue; }
          if (evt.type === 'meta') {
            setModeLabel(modeText(evt), evt.mode === 'local' ? '#8a5a12' : '#1f7a68');
          } else if (evt.type === 'status') {
            if (!buffer) setStatus(evt.text);
          } else if (evt.type === 'delta') {
            push(evt.text);
          } else if (evt.type === 'done') {
            if (evt.fallback) window.UI.toast('在线通道没连上，已切到本地讲解', 'err');
          }
        }
      }
    };

    /* 浏览器直连免费通道：用访客自己的 IP 额度 */
    const runClientFree = async function () {
      const sys = await window.API.post('/api/ai/prompt/chat', {
        problemCode: s.problemCode || ctx.problemCode || '',
        expert: expertOn
      });
      setModeLabel('免费通道 · 本机直连', '#1f7a68');
      setStatus('免费通道思考中…');
      const messages = [{ role: 'system', content: sys.system }].concat(s.messages.slice(-14));
      await window.FreeLLM.stream(messages, push);
    };

    try {
      const own = loadLlmCfg();
      const siteReady = !!(window.API.State.llm && window.API.State.llm.configured);

      if (own || siteReady || !window.FreeLLM) {
        await runServer();
      } else {
        try {
          await runClientFree();
        } catch (e) {
          if (e.code === 'FREE_LIMIT') {
            window.UI.toast('免费通道 45 秒一次，先用本地讲解顶上', 'err');
          } else {
            window.UI.toast('免费通道不稳，先用本地讲解', 'err');
          }
          buffer = '';
          if (last) last.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
          await runServer({ skipFree: true });
        }
      }
      finish();
    } catch (e) {
      const errText = '**出错了**：' + e.message + '\n\n可以稍后重试，或先在题目页看分层提示。';
      s.messages.push({ role: 'assistant', content: errText });
      persist();
      if (last) window.Md.render(last, errText);
      window.UI.toast(e.message, 'err');
    } finally {
      streaming = false;
      if (sendBtn) sendBtn.disabled = false;
      const ta2 = document.getElementById('aiInput');
      if (ta2) ta2.focus();
    }
  }

  /* ---------------------------------------------------------- 模型设置 */

  function openLlmSettings() {
    window.UI.llmSettings();
  }

  /* ---------------------------------------------------------- 打开 / 关闭 */

  function open(opts) {
    opts = opts || {};
    if (shell) close();
    ctx = { problemCode: opts.problemCode || '', title: opts.title || '', statement: opts.statement || '' };

    sessions = loadSessions();
    const existing = sessions.find(function (s) {
      return (s.problemCode || '') === ctx.problemCode && Date.now() - (s.updatedAt || 0) < 1000 * 60 * 60 * 6;
    });
    if (existing) activeId = existing.id;
    else makeSession(ctx.problemCode, ctx.title || '新对话');

    shell = document.createElement('div');
    shell.className = 'ai-shell';
    shell.innerHTML =
      '<aside class="ai-side">'
      + '<div class="ai-side-head">'
      + '<div class="ai-brand"><span class="mark">∫</span><span>高数助教</span><span class="small muted right">AI</span></div>'
      + '<button class="ai-new" id="newConv">＋ 新建对话</button>'
      + '</div>'
      + '<div class="ai-conv-list" id="convList"></div>'
      + '<div class="ai-side-foot"><div>当前通道：<span id="modeLabel">' + (loadLlmCfg() ? '我的 Key' : (window.API.State.llm && window.API.State.llm.configured ? '站点模型' : '免费通道 · Pollinations')) + '</span></div>'
      + '<button class="btn btn-sm btn-ghost btn-block" id="closeChat">← 返回站点</button></div>'
      + '</aside>'
      + '<div class="ai-main">'
      + '<div class="ai-top"><span id="aiTitle">新对话</span><span class="ctx" id="ctxChip" style="display:none"></span>'
      + '<button class="icon-btn ai-close" id="closeChat2">关闭</button></div>'
      + '<div class="ai-scroll" id="aiScroll"><div id="aiContent"></div></div>'
      + '<div class="ai-composer-wrap"><div class="ai-composer">'
      + '<textarea id="aiInput" rows="1" placeholder="问点什么…（Enter 发送，Shift + Enter 换行）"></textarea>'
      + '<div class="ai-tools">'
      + '<button class="ai-toggle" id="deepBtn" title="需要接入推理模型后可用">深度思考</button>'
      + '<button class="ai-toggle" id="webBtn" title="暂未接入联网">联网搜索</button>'
      + '<button class="ai-toggle on" id="expertBtn" title="按「审题→考点→策略→执行→验算→易错点」六步讲，并参考题库同考点题">专家模式</button>'
      + '<button class="ai-toggle" id="llmBtn" title="用自己的 API Key，或查看当前通道">模型</button>'
      + '<button class="ai-send" id="aiSend" title="发送">' + window.UI.icon('send') + '</button>'
      + '</div></div>'
      + '<div class="ai-hint">AI 也会算错，关键步骤请自己验算 · 公式由 KaTeX 渲染</div></div>'
      + '</div>';
    document.getElementById('overlay-root').appendChild(shell);

    renderConvList();
    renderThread();

    document.getElementById('newConv').addEventListener('click', function () {
      if (streaming) { window.UI.toast('正在回答，稍等一下'); return; }
      makeSession(ctx.problemCode, ctx.title || '新对话');
      renderConvList();
      renderThread();
    });
    document.getElementById('closeChat').addEventListener('click', close);
    document.getElementById('closeChat2').addEventListener('click', close);
    document.getElementById('deepBtn').addEventListener('click', function () {
      this.classList.toggle('on');
      window.UI.toast('深度思考需要接入推理模型，当前为普通对话');
    });
    document.getElementById('webBtn').addEventListener('click', function () {
      window.UI.toast('联网搜索暂未接入');
    });
    document.getElementById('llmBtn').addEventListener('click', openLlmSettings);
    const expertBtn = document.getElementById('expertBtn');
    expertBtn.addEventListener('click', function () {
      expertOn = !expertOn;
      expertBtn.classList.toggle('on', expertOn);
      window.UI.toast(expertOn ? '专家模式：按六步法讲，会参考题库同类题' : '已关掉专家模式，回答会更短');
    });

    const input = document.getElementById('aiInput');
    const sendBtn = document.getElementById('aiSend');
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(180, input.scrollHeight) + 'px';
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const v = input.value;
        input.value = '';
        input.style.height = 'auto';
        send(v);
      }
    });
    sendBtn.addEventListener('click', function () {
      const v = input.value;
      input.value = '';
      input.style.height = 'auto';
      send(v);
    });

    document.addEventListener('keydown', onKey);
    setTimeout(function () { input.focus(); }, 80);

    // 首次进入题目上下文时自动带一句引导
    const s = active();
    if (s && !s.messages.length && opts.autoAsk) {
      send(opts.autoAsk);
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    if (shell) { shell.remove(); shell = null; }
    streaming = false;
  }

  window.Chat = { open: open, close: close, llmConfig: loadLlmCfg, refreshModeLabel: refreshModeLabel };

  function refreshModeLabel() {
    const own = loadLlmCfg();
    const site = !!(window.API.State.llm && window.API.State.llm.configured);
    setModeLabel(own ? ('我的 Key · ' + own.model) : (site ? '站点模型' : '免费通道 · 本机直连'));
  }
})();
