/* 通用 UI：头部、Toast、模态框、登录、分页、评分条 */
(function () {
  'use strict';

  const St = window.API.State;

  const LEVELS = [
    { max: 3, name: '基础巩固', color: '#4ade80' },
    { max: 5, name: '常规练习', color: '#38bdf8' },
    { max: 7, name: '综合提高', color: '#fbbf24' },
    { max: 8, name: '考研冲刺', color: '#fb923c' },
    { max: 9, name: '竞赛入门', color: '#f87171' },
    { max: 10, name: '竞赛压轴', color: '#c084fc' }
  ];

  const ESC = window.Md.esc;

  function levelOf(d) {
    const n = Math.max(1, Math.min(10, Number(d) || 5));
    for (const l of LEVELS) if (n <= l.max) return l;
    return LEVELS[LEVELS.length - 1];
  }

  function toast(msg, type) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'err' ? ' err' : type === 'ok' ? ' ok' : '');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .2s, transform .2s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 220);
    }, type === 'err' ? 3600 : 2400);
  }

  function hueOf(str) {
    let h = 0;
    for (let i = 0; i < String(str).length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }

  function avatar(name, cls) {
    const n = String(name || '?');
    const h = hueOf(n);
    return '<span class="avatar ' + (cls || '') + '" style="background:linear-gradient(140deg,hsl(' + h + ',52%,52%),hsl(' + ((h + 40) % 360) + ',46%,38%))">'
      + ESC(n.slice(0, 1).toUpperCase()) + '</span>';
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const diff = Date.now() - t;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' 小时前';
    const d = Math.floor(hr / 24);
    if (d < 8) return d + ' 天前';
    const dt = new Date(iso);
    return (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function scoreBars(p, compact) {
    const items = [
      { k: '思维量', short: '思维', v: p.thinking },
      { k: '难度', short: '难度', v: p.difficulty },
      { k: '计算量', short: '计算', v: p.calc }
    ];
    return '<div class="scores">' + items.map(function (it) {
      const v = Math.max(1, Math.min(10, Number(it.v) || 5));
      const cls = v >= 8 ? 'hi' : v >= 6 ? 'mid' : '';
      return '<div class="score-item">'
        + '<div class="score-top"><span>' + (compact ? it.short : it.k) + '</span><b>' + v + '</b></div>'
        + '<div class="score-track"><div class="score-fill ' + cls + '" style="width:' + (v * 10) + '%"></div></div>'
        + '</div>';
    }).join('') + '</div>';
  }

  function levelBadge(p) {
    const lv = levelOf(p.difficulty);
    return '<span class="level-badge" style="color:' + lv.color + '"><i class="level-dot"></i>' + ESC(lv.name) + '</span>';
  }

  /* ---------------------------------------------------------- 模态框 */

  function modal(opts) {
    const root = document.getElementById('modal-root');
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal' + (opts.wide ? ' wide' : '') + '" style="position:relative">'
      + '<button class="modal-close" aria-label="关闭">×</button>'
      + (opts.title ? '<h2>' + ESC(opts.title) + '</h2>' : '')
      + (opts.sub ? '<div class="modal-sub">' + ESC(opts.sub) + '</div>' : '')
      + '<div class="modal-body"></div>'
      + '</div>';
    const body = mask.querySelector('.modal-body');
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    root.appendChild(mask);

    function close() {
      document.removeEventListener('keydown', onKey);
      mask.remove();
      if (opts.onClose) opts.onClose();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    mask.querySelector('.modal-close').addEventListener('click', close);
    mask.addEventListener('mousedown', function (e) { if (e.target === mask) close(); });
    document.addEventListener('keydown', onKey);

    if (opts.onMount) opts.onMount(body, close);
    return { el: mask, body: body, close: close };
  }

  /* ---------------------------------------------------------- 登录 / 注册 */

  function authModal(mode) {
    let current = mode === 'register' ? 'register' : 'login';
    const el = document.createElement('div');
    el.innerHTML =
      '<div class="seg" style="margin-bottom:18px">'
      + '<button data-mode="login">登录</button>'
      + '<button data-mode="register">注册</button>'
      + '</div>'
      + '<form id="authForm">'
      + '<div class="field"><label>用户名</label><input name="name" autocomplete="username" placeholder="2-16 位，中英文皆可" maxlength="16" /></div>'
      + '<div class="field"><label>密码</label><input name="password" type="password" autocomplete="current-password" placeholder="至少 6 位" /></div>'
      + '<div class="form-error" id="authErr"></div>'
      + '<button class="btn btn-primary btn-block" type="submit" id="authSubmit" style="height:38px;margin-top:6px">登录</button>'
      + '</form>'
      + '<div class="small muted" id="authTip" style="margin-top:14px;text-align:center"></div>';

    const m = modal({ title: '欢迎回来', sub: '登录后可以发帖、记录做题经验、向 AI 追问', body: el });

    const form = el.querySelector('#authForm');
    const errEl = el.querySelector('#authErr');
    const submit = el.querySelector('#authSubmit');
    const tip = el.querySelector('#authTip');

    function sync() {
      el.querySelectorAll('.seg button').forEach(function (b) {
        b.classList.toggle('active', b.dataset.mode === current);
      });
      submit.textContent = current === 'login' ? '登录' : '注册并登录';
      tip.textContent = current === 'register' ? '第一个注册的账号会自动成为管理员，负责题目审核。' : '';
      errEl.textContent = '';
    }

    el.querySelectorAll('.seg button').forEach(function (b) {
      b.addEventListener('click', function () { current = b.dataset.mode; sync(); });
    });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      const name = form.name.value.trim();
      const password = form.password.value;
      if (!name || !password) { errEl.textContent = '请填写用户名和密码'; return; }
      submit.disabled = true;
      submit.textContent = '处理中…';
      try {
        const data = await window.API.post('/api/auth/' + (current === 'login' ? 'login' : 'register'), { name: name, password: password });
        window.UI.applyUser(data.user);
        m.close();
        toast(current === 'login' ? '已登录，欢迎回来 ' + data.user.name : '注册成功，' + data.user.name, 'ok');
        if (data.isFirstAdmin) {
          setTimeout(function () { toast('你是第一个账号，已成为管理员', 'ok'); }, 600);
        }
        window.App.refresh();
      } catch (err) {
        errEl.textContent = err.message;
      } finally {
        submit.disabled = false;
        submit.textContent = current === 'login' ? '登录' : '注册并登录';
      }
    });

    sync();
    setTimeout(function () { form.name.focus(); }, 60);
    return m;
  }

  function requireLogin(action, hint) {
    if (St.me) return true;
    toast(hint || '请先登录', 'err');
    authModal('login');
    return false;
  }

  /* ---------------------------------------------------------- 头部 */

  function applyUser(user) {
    St.me = user || null;
    renderHeader();
  }

  function renderHeader() {
    const area = document.getElementById('userArea');
    if (!area) return;
    const me = St.me;
    if (!me) {
      area.innerHTML =
        '<button class="btn btn-sm btn-ghost" id="navLogin">登录</button>'
        + '<button class="btn btn-sm btn-primary" id="navRegister">注册</button>';
      area.querySelector('#navLogin').addEventListener('click', function () { authModal('login'); });
      area.querySelector('#navRegister').addEventListener('click', function () { authModal('register'); });
      return;
    }

    const pct = Math.round((me.levelProgress || 0) * 100);
    const adminEntry = me.role === 'admin'
      ? '<a href="#/admin">审核后台</a><div class="sep"></div>'
      : '';

    area.innerHTML =
      '<div class="xp-chip" title="Lv.' + me.level + ' · ' + me.exp + ' 经验">'
      + '<span class="xp-ring" style="--p:' + (pct / 100) + '"><span>' + me.level + '</span></span>'
      + '<span><b>' + me.exp + '</b> 经验</span>'
      + '</div>'
      + '<div class="user-menu" id="userMenu">'
      + '<button class="user-btn" id="userBtn">' + avatar(me.name) + '<span>' + ESC(me.name) + '</span></button>'
      + '<div class="dropdown" id="userDropdown">'
      + '<div class="hint">Lv.' + me.level + ' · 已做 ' + me.solvedCount + ' 题 · ' + me.exp + ' 经验</div>'
      + '<a href="#/my">我的记录</a>'
      + '<div class="sep"></div>'
      + adminEntry
      + '<button id="logoutBtn">退出登录</button>'
      + '</div></div>';

    const btn = area.querySelector('#userBtn');
    const dd = area.querySelector('#userDropdown');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      dd.classList.toggle('open');
    });
    document.addEventListener('click', function () { dd.classList.remove('open'); });
    area.querySelector('#logoutBtn').addEventListener('click', async function () {
      try { await window.API.post('/api/auth/logout'); } catch (e) {}
      window.API.setToken('');
      applyUser(null);
      toast('已退出登录');
      window.App.refresh();
    });
  }

  function setActiveNav(name) {
    document.querySelectorAll('#nav a').forEach(function (a) {
      a.classList.toggle('active', a.dataset.nav === name);
    });
  }

  /* ---------------------------------------------------------- 分页 */

  function pagination(page, pages, onGo) {
    const wrap = document.createElement('div');
    wrap.className = 'pagination';
    if (pages <= 1) return wrap;

    const btn = function (label, p, opts) {
      const b = document.createElement('button');
      b.textContent = label;
      if (opts && opts.active) b.className = 'active';
      if (opts && opts.disabled) b.disabled = true;
      if (!opts || !opts.disabled) b.addEventListener('click', function () { onGo(p); });
      return b;
    };

    wrap.appendChild(btn('‹', page - 1, { disabled: page <= 1 }));

    const nums = [];
    const push = function (n) { if (nums.indexOf(n) < 0 && n >= 1 && n <= pages) nums.push(n); };
    push(1); push(2);
    for (let i = page - 1; i <= page + 1; i++) push(i);
    push(pages - 1); push(pages);
    nums.sort(function (a, b) { return a - b; });

    let last = 0;
    nums.forEach(function (n) {
      if (last && n - last > 1) {
        const sp = document.createElement('span');
        sp.className = 'info';
        sp.textContent = '…';
        wrap.appendChild(sp);
      }
      wrap.appendChild(btn(String(n), n, { active: n === page }));
      last = n;
    });

    wrap.appendChild(btn('›', page + 1, { disabled: page >= pages }));
    return wrap;
  }

  /* ---------------------------------------------------------- 其它 */

  function icon(name) {
    const paths = {
      search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4L14 14"/>',
      check: '<path d="M2.5 7.2l3 3 5.5-6"/>',
      plus: '<path d="M7 2.5v9M2.5 7h9"/>',
      send: '<path d="M2.5 7l10-4.5L9 12.5 7 8.5 2.5 7z"/>',
      refresh: '<path d="M12 7a5 5 0 1 1-1.6-3.7M12 2.2V5H9.2"/>',
      back: '<path d="M8.5 3L4 7l4.5 4"/>',
      spark: '<path d="M7 2l1.3 3.4L11.5 7 8.3 8.6 7 12 5.7 8.6 2.5 7l3.2-1.6L7 2z"/>'
    };
    return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">'
      + (paths[name] || '') + '</svg>';
  }

  function empty(title, sub) {
    return '<div class="empty"><b>' + ESC(title) + '</b>' + (sub ? ESC(sub) : '') + '</div>';
  }


  /* ---------------------------------------------------- 模型通道设置 */

  const LLM_KEY = 'mv_llm_v1';

  function llmConfig() {
    try {
      const v = JSON.parse(localStorage.getItem(LLM_KEY) || 'null');
      return v && v.apiKey ? v : null;
    } catch (e) { return null; }
  }

  function saveLlmConfig(cfg) {
    try {
      if (cfg) localStorage.setItem(LLM_KEY, JSON.stringify(cfg));
      else localStorage.removeItem(LLM_KEY);
    } catch (e) {}
  }

  function llmSettings() {
    const cur = llmConfig() || {};
    const siteReady = !!(window.API.State.llm && window.API.State.llm.configured);
    const el = document.createElement('div');
    el.innerHTML =
      '<div class="small muted" style="margin-bottom:12px">当前通道：<b>'
      + (cur.apiKey ? '我的 Key · ' + ESC(cur.model || '') : (siteReady ? '站点模型' : '免费通道 · Pollinations'))
      + '</b></div>'
      + '<div class="field"><label>接口地址（OpenAI 兼容）</label>'
      + '<input id="llmBase" value="' + ESC(cur.baseUrl || 'https://api.deepseek.com/v1') + '" placeholder="https://api.deepseek.com/v1" /></div>'
      + '<div class="field"><label>模型名</label>'
      + '<input id="llmModel" value="' + ESC(cur.model || 'deepseek-chat') + '" placeholder="deepseek-chat" /></div>'
      + '<div class="field"><label>API Key</label>'
      + '<input id="llmKey" type="password" value="' + ESC(cur.apiKey || '') + '" placeholder="sk-..." autocomplete="off" />'
      + '<div class="tip">只保存在这台设备的浏览器（localStorage），不写进站点数据库，别人看不到。换了设备要重新填。</div></div>'
      + '<div class="small muted" style="margin:4px 0 14px;line-height:1.8">不填也能用：问答与判卷会走免费公共通道（Pollinations，同一网络 45 秒一次），再不行用内置讲解。<br/>'
      + '判卷要读手写照片时，模型名需要支持图片，例如 <code>gpt-4o</code>、<code>qwen-vl-max</code>、<code>glm-4v</code>、<code>claude-3-5-sonnet</code>、<code>gemini-1.5-pro</code>。</div>'
      + '<div style="display:flex;gap:9px;justify-content:flex-end">'
      + '<button class="btn" id="clearLlm">清除</button>'
      + '<button class="btn btn-primary" id="saveLlm">保存</button></div>';

    const m = modal({ title: '设置 · 模型通道', sub: '用自己的 Key 可以不受免费通道限速', body: el, wide: true });

    el.querySelector('#saveLlm').addEventListener('click', function () {
      const baseUrl = el.querySelector('#llmBase').value.trim();
      const model = el.querySelector('#llmModel').value.trim();
      const apiKey = el.querySelector('#llmKey').value.trim();
      if (!apiKey) {
        saveLlmConfig(null);
        toast('没填 Key，继续用免费通道', 'ok');
        m.close();
        if (window.Chat && window.Chat.refreshModeLabel) window.Chat.refreshModeLabel();
        return;
      }
      saveLlmConfig({ baseUrl: baseUrl || 'https://api.deepseek.com/v1', model: model || 'deepseek-chat', apiKey: apiKey });
      toast('已保存到本机，问答与判卷都会优先用你的模型', 'ok');
      m.close();
      if (window.Chat && window.Chat.refreshModeLabel) window.Chat.refreshModeLabel();
    });

    el.querySelector('#clearLlm').addEventListener('click', function () {
      saveLlmConfig(null);
      toast('已清除，回到免费通道', 'ok');
      m.close();
      if (window.Chat && window.Chat.refreshModeLabel) window.Chat.refreshModeLabel();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    const btn = document.getElementById('settingsBtn');
    if (btn) btn.addEventListener('click', llmSettings);
  });

  window.UI = {
    LEVELS, levelOf, levelBadge, toast, avatar, timeAgo, fmtDate,
    scoreBars, modal, authModal, requireLogin, applyUser, renderHeader,
    setActiveNav, pagination, icon, empty, ESC,
    llmConfig, saveLlmConfig, llmSettings
  };
})();
