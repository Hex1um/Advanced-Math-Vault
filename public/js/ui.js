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
    /* 安全契约：opts.body 传字符串时按「已安全的 HTML」直接插入（标题/副标题由 ESC 处理）。
       调用方必须自己过 Md.esc 转义所有用户内容，或者干脆传 DOM 节点 —— 传节点是更安全的写法。
       这里不做二次转义，是因为调用方大量传入带标签的模板串，转义会把弹窗结构打坏。 */
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

  /* 右上角菜单的开合状态放在模块级，而不是只存在 DOM 上。
     页头会因为 meta 到货、登录态变化、路由刷新被反复重建（innerHTML 整体替换），
     状态只存在 DOM 里的话，重建一次菜单就自己关上了——表现就是「点开瞬间消失」。 */
  let dropdownOpen = false;
  function setDropdown(open) {
    dropdownOpen = !!open;
    const dd = document.getElementById('userDropdown');
    if (dd) dd.classList.toggle('open', dropdownOpen);
  }

  /* 换页时收起：返回上一页、点导航、键盘前进后退都可能不经过 click，
     不收的话菜单会一直悬在内容上（手机上尤其明显） */
  window.addEventListener('hashchange', function () { setDropdown(false); });

  /* 全局只注册一次：以前在 renderHeader 里注册，页头重建 N 次就叠 N 个监听器 */
  document.addEventListener('click', function (e) {
    const menu = document.getElementById('userMenu');
    if (!menu) return;
    if (!menu.contains(e.target)) { setDropdown(false); return; }
    /* 点菜单里的链接或按钮：执行完收起；点头像按钮交给它自己的 toggle */
    if (e.target.closest('.dropdown a, .dropdown button')) setDropdown(false);
  });

  function applyUser(user) {
    St.me = user || null;
    if (!user) setDropdown(false);
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
    if (dropdownOpen) dd.classList.add('open');
    btn.addEventListener('click', function () { setDropdown(!dropdownOpen); });
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

  /* 两套模型：解题（文本/判卷）与识图（视觉，读手写照片）分开配 */
  const LLM_KEY = 'mv_llm_v2';
  const LLM_KEY_V1 = 'mv_llm_v1';

  function readAll() {
    let v2 = null;
    try { v2 = JSON.parse(localStorage.getItem(LLM_KEY) || 'null'); } catch (e) {}
    if (v2 && (v2.text || v2.vision)) return v2;
    // 迁移旧版单通道配置
    let v1 = null;
    try { v1 = JSON.parse(localStorage.getItem(LLM_KEY_V1) || 'null'); } catch (e) {}
    if (v1 && v1.apiKey) {
      const isVision = /gpt-4o|gpt-4\.1|claude|gemini|qwen.*vl|glm-4v|vision|llava|internvl/i.test(v1.model || '');
      return { text: isVision ? null : v1, vision: isVision ? v1 : null };
    }
    return { text: null, vision: null };
  }

  function writeAll(all) {
    try { localStorage.setItem(LLM_KEY, JSON.stringify(all)); } catch (e) {}
  }

  /* 解题模型：问答、判卷、出题 */
  function llmConfig() {
    const c = readAll().text;
    return c && c.apiKey ? c : null;
  }

  /* 识图模型：读图转写、图片判卷；没单独配就退回解题模型（若它本身支持图片） */
  function visionConfig() {
    const all = readAll();
    if (all.vision && all.vision.apiKey) return all.vision;
    const t = all.text;
    if (t && t.apiKey && /gpt-4o|gpt-4\.1|claude|gemini|qwen.*vl|glm-4v|vision|llava|internvl/i.test(t.model || '')) return t;
    return null;
  }

  function saveLlmConfig(cfg, which) {
    const all = readAll();
    if (!cfg) {
      if (which === 'vision') all.vision = null;
      else if (which === 'text') all.text = null;
      else { all.text = null; all.vision = null; }
    } else {
      if (which === 'vision') all.vision = cfg;
      else all.text = cfg;
    }
    writeAll(all);
  }

  function llmSettings() {
    const all = readAll();
    const curT = all.text || {};
    const curV = all.vision || {};
    const siteReady = !!(window.API.State.llm && window.API.State.llm.configured);
    const el = document.createElement('div');
    const vFromT = !!(curT.apiKey && /gpt-4o|gpt-4\.1|claude|gemini|qwen.*vl|glm-4v|vision|llava|internvl/i.test(curT.model || ''));
    el.innerHTML =
      '<div class="small muted" style="margin-bottom:12px">当前：解题 <b>'
      + (curT.apiKey ? ESC(curT.model || '') : (siteReady ? '站点模型' : '免费通道'))
      + '</b>　·　识图 <b>' + (curV.apiKey ? ESC(curV.model || '') : (vFromT ? '沿用解题模型' : '未配置')) + '</b></div>'

      + '<div class="form-section-title">解题模型（问答 / 判卷 / 出题）</div>'
      + '<div class="field"><label>接口地址</label><input id="llmBase" value="' + ESC(curT.baseUrl || 'https://api.deepseek.com/v1') + '" /></div>'
      + '<div class="field"><label>模型名</label><input id="llmModel" value="' + ESC(curT.model || 'deepseek-chat') + '" /></div>'
      + '<div class="field"><label>API Key</label><input id="llmKey" type="password" value="' + ESC(curT.apiKey || '') + '" autocomplete="off" /></div>'

      + '<div class="form-section-title" style="margin-top:16px">识图模型（读手写 / 拍照）</div>'
      + '<div class="small muted" style="margin:0 0 8px;line-height:1.8">手写题只有视觉模型能读准。下面几个目前免费：</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">'
      + '<button type="button" class="btn btn-sm" data-preset="glm">智谱 GLM-4V-Flash（免费）</button>'
      + '<button type="button" class="btn btn-sm" data-preset="sensetime">商汤 sensenova</button>'
      + '<button type="button" class="btn btn-sm" data-preset="openrouter">OpenRouter 免费 VL</button>'
      + '<button type="button" class="btn btn-sm" data-preset="same">沿用解题模型</button>'
      + '</div>'
      + '<div class="field"><label>接口地址</label><input id="visBase" value="' + ESC(curV.baseUrl || '') + '" placeholder="https://open.bigmodel.cn/api/paas/v4" /></div>'
      + '<div class="field"><label>模型名</label><input id="visModel" value="' + ESC(curV.model || '') + '" placeholder="glm-4v-flash" /></div>'
      + '<div class="field"><label>API Key</label><input id="visKey" type="password" value="' + ESC(curV.apiKey || '') + '" placeholder="可以和解题模型不同" autocomplete="off" />'
      + '<div class="tip">都只存在这台设备的浏览器里。留空表示不单独配置：识图会按解题模型是否支持图片来决定。</div></div>'

      + '<div style="display:flex;gap:9px;justify-content:flex-end;margin-top:6px">'
      + '<button class="btn" id="clearLlm">全部清除</button>'
      + '<button class="btn btn-primary" id="saveLlm">保存</button></div>';

    const m = modal({ title: '设置 · 模型通道', sub: '解题与识图可以各用各的', body: el, wide: true });

    const presets = {
      glm: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash' },
      sensetime: { baseUrl: 'https://api.sensenova.cn/compatible-mode/v1', model: 'SenseNova-V6-5-Turbo' },
      openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen2.5-vl-72b-instruct:free' }
    };
    el.querySelectorAll('[data-preset]').forEach(function (b) {
      b.addEventListener('click', function () {
        const k = b.dataset.preset;
        if (k === 'same') {
          el.querySelector('#visBase').value = el.querySelector('#llmBase').value;
          el.querySelector('#visModel').value = el.querySelector('#llmModel').value;
          el.querySelector('#visKey').value = el.querySelector('#llmKey').value;
          toast('识图已设为沿用解题模型', 'ok');
          return;
        }
        const pr = presets[k];
        if (!pr) return;
        el.querySelector('#visBase').value = pr.baseUrl;
        el.querySelector('#visModel').value = pr.model;
        toast('已填入 ' + pr.model + '，把 Key 填上再保存', 'ok');
      });
    });

    el.querySelector('#saveLlm').addEventListener('click', function () {
      const t = {
        baseUrl: el.querySelector('#llmBase').value.trim(),
        model: el.querySelector('#llmModel').value.trim(),
        apiKey: el.querySelector('#llmKey').value.trim()
      };
      const v = {
        baseUrl: el.querySelector('#visBase').value.trim(),
        model: el.querySelector('#visModel').value.trim(),
        apiKey: el.querySelector('#visKey').value.trim()
      };
      const all2 = readAll();
      all2.text = (t.apiKey && t.model) ? t : null;
      all2.vision = (v.apiKey && v.model) ? v : null;
      writeAll(all2);
      toast('已保存：解题用 ' + (all2.text ? all2.text.model : '站点/免费通道')
        + '，识图用 ' + (all2.vision ? all2.vision.model : '自动判断'), 'ok');
      m.close();
      if (window.Chat && window.Chat.refreshModeLabel) window.Chat.refreshModeLabel();
    });

    el.querySelector('#clearLlm').addEventListener('click', function () {
      writeAll({ text: null, vision: null });
      toast('已全部清除，回到免费通道', 'ok');
      m.close();
      if (window.Chat && window.Chat.refreshModeLabel) window.Chat.refreshModeLabel();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    const btn = document.getElementById('settingsBtn');
    if (btn) btn.addEventListener('click', llmSettings);
  });

  /* 语义色：暗色和浅色要不同的亮度，不要在模板里写死 hex */
  function tone(name) {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const map = {
      ok: dark ? '#8ee6a8' : '#2f7a41',
      warn: dark ? '#ffd9a3' : '#8a5a12',
      err: dark ? '#ff9b9b' : '#b93a3a',
      info: dark ? '#9dc0ff' : '#1f57c9',
      teal: dark ? '#9df0e0' : '#1f7a68',
      panel: dark ? '#1e2a42' : '#f7faff',
      panelLine: dark ? '#2c3c5c' : '#dbe6fa'
    };
    return map[name] || 'var(--text)';
  }


  /* 主标签 + 子标签 + 题型：全站统一用这一套渲染，避免各页面各写各的 */
  function tagBadges(p, opts) {
    const o = opts || {};
    const parts = [];
    if (p && p.mainTag && !o.hideMain) parts.push('<span class="tag tag-main">' + ESC(p.mainTag) + '</span>');
    for (const t of (p && p.examTags) || []) parts.push('<span class="tag gold">' + ESC(t) + '</span>');
    if (p && p.kind && o.showKind) parts.push('<span class="tag gray">' + ESC(p.kind) + '</span>');
    for (const t of (p && p.tags) || []) parts.push('<span class="tag">' + ESC(t) + '</span>');
    return parts.join('');
  }

  function mainTagOptions(selected) {
    const tree = St.tagTree || [];
    const names = tree.length ? tree.map(function (x) { return x.name; }) : [];
    return ['<option value="">自动判断</option>'].concat(names.map(function (name) {
      return '<option value="' + ESC(name) + '"' + (name === selected ? ' selected' : '') + '>' + ESC(name) + '</option>';
    })).join('');
  }

  window.UI = {
    LEVELS, levelOf, levelBadge, toast, avatar, timeAgo, fmtDate,
    scoreBars, modal, authModal, requireLogin, applyUser, renderHeader,
    setActiveNav, pagination, icon, empty, ESC, tone,
    tagBadges, mainTagOptions,
    llmConfig, visionConfig, saveLlmConfig, llmSettings
  };
})();
