/* 极简 API 客户端 + 全局状态（支持跨域 token，静态托管上也能用） */

/**
 * 前端接口契约（保持零构建，用 JSDoc 而不是 TS）。
 * 后端返回的统一形状：成功 `{ok:true, ...}`，失败 `{ok:false, error:string}`。
 *
 * @typedef {Object} ApiOk
 * @property {true} ok
 *
 * @typedef {Object} ApiFail
 * @property {false} ok
 * @property {string} error
 *
 * @typedef {ApiFail & {status?: number, data?: ApiFail}} ApiError
 *   `request()` 抛出的错误对象：`error.status` 是 HTTP 状态码，`error.data` 是原始失败响应体（401 会自动清 token）
 *
 * @typedef {Object} RequestOptions
 * @property {'GET'|'POST'} [method]
 * @property {Object|string} [body] 传对象会自动 JSON 序列化并补 Content-Type
 * @property {Object<string,string>} [headers]
 *
 * @typedef {Object} LlmState
 * @property {boolean} configured 站点是否配了 Key
 * @property {string} model
 * @property {string[]} free 浏览器直连的免费通道名
 *
 * @typedef {Object} AppState
 * @property {?Object} me 当前登录用户（publicUser 形状）
 * @property {?Object} meta /api/meta 的统计与标签树
 * @property {string[]} tags 扁平的子标签全集
 * @property {string[]} tagTree 九大主标签
 * @property {string[]} examTags 来源标签（华科期中 / 华科期末）
 * @property {LlmState} llm
 * @property {?Object} stats
 * @property {{name: string, params: Object}} route
 */
(function () {
  'use strict';

  /** @type {AppState} */
  const State = {
    me: null,
    meta: null,
    tags: [],
    tagTree: [],
    examTags: [],
    llm: { configured: false, model: '', free: [] },
    stats: null,
    /* 当前学科：math | physics。切换后所有列表/统计/组卷按它取数，
       持久化到 localStorage，刷新与分享链接都不丢。 */
    subject: 'math',
    route: { name: 'library', params: {} }
  };

  const SUBJECT_KEY = 'mv_subject';
  const SUBJECT_META = {
    math: { key: 'math', name: '数学', label: '高等数学', brand: '高等数学 · 好题收藏室', daily: '每日一积' },
    physics: { key: 'physics', name: '物理', label: '大学物理', brand: '大学物理 · 好题收藏室', daily: '每日一物' }
  };

  function readSubject() {
    try {
      const v = localStorage.getItem(SUBJECT_KEY);
      if (v === 'physics' || v === 'math') return v;
    } catch (e) {}
    return 'math';
  }

  State.subject = readSubject();
  State.subjectInfo = function (key) { return SUBJECT_META[key === 'physics' ? 'physics' : 'math']; };
  State.subjectQuery = function (sep) {
    return (sep === undefined ? '?' : sep) + 'subject=' + State.subject;
  };
  /** 给以 /api/ 开头的路径补上 subject 参数（已有 subject 或非 API 路径原样返回） */
  State.withSubject = function (path) {
    const s = String(path || '');
    if (!s || s.indexOf('/api/') !== 0 || /[?&]subject=/.test(s)) return s;
    return s + (s.indexOf('?') >= 0 ? '&' : '?') + 'subject=' + State.subject;
  };
  State.setSubject = function (next, opts) {
    const key = next === 'physics' ? 'physics' : 'math';
    if (key === State.subject) return;
    State.subject = key;
    try { localStorage.setItem(SUBJECT_KEY, key); } catch (e) {}
    /* meta 里带了两个学科的标签树，切换时直接换树，不必再等一次请求 */
    const trees = (State.meta && State.meta.tagTrees) || null;
    if (trees && trees[key]) {
      State.tagTree = trees[key] || [];
      State.tags = State.tagTree.reduce(function (arr, m) { return arr.concat(m.children || []); }, []);
    }
    State.emit('subject:changed', { subject: key, info: SUBJECT_META[key], silent: !!(opts && opts.silent) });
  };

  /* ------------------------------------------------------------- 事件总线
     State 原来是普通可变对象：登录/退出/刷新元信息后，各个视图得自己记得同步 UI，
     漏一个就是「页头显示已登录、错题本还提示请登录」。
     这里用原生 EventTarget 做一个极简发布订阅，不引入任何依赖。 */
  const bus = (typeof EventTarget === 'function') ? new EventTarget() : null;
  const handlers = new Map();

  State.subscribe = function (event, fn) {
    if (!bus || typeof fn !== 'function') return function () {};
    const wrapped = function (e) { try { fn(e && e.detail); } catch (err) { console.error('[state]', event, err); } };
    bus.addEventListener(event, wrapped);
    handlers.set(fn, { event: event, wrapped: wrapped });
    return function unsubscribe() {
      bus.removeEventListener(event, wrapped);
      handlers.delete(fn);
    };
  };

  State.emit = function (event, detail) {
    if (!bus) return;
    try { bus.dispatchEvent(new CustomEvent(event, { detail: detail })); }
    catch (e) { /* 老浏览器没有 CustomEvent 构造器时静默降级 */ }
  };

  /** 拉取并广播元信息（登录态、统计、标签树） */
  State.applyMeta = function (meta) {
    if (!meta) return;
    /* 只有「登录的人真的变了」才广播 auth:changed。
       以前是「只要 me 存在就广播」，而 app.js 收到 auth:changed 会再拉一次 meta，
       于是形成 meta → applyMeta → auth:changed → refreshMeta → meta 的死循环：
       登录状态下每秒打上千次 /api/meta，页头被反复重建，右上角菜单点开就没了。 */
    const prevKey = (State.me && State.me.id) || '';
    const nextKey = (meta.me && meta.me.id) || '';
    State.me = meta.me;
    State.stats = meta.stats;
    /* 学科树优先：后端 v2.7+ 返回 tagTrees.math / tagTrees.physics，
       旧后端只有 tagTree（数学），此时 physics 树为空，前端会提示「还没有物理题」。 */
    const trees = meta.tagTrees || null;
    State.tagTree = (trees && trees[State.subject]) || meta.tagTree || [];
    State.examTags = meta.examTags || [];
    State.tags = (State.tagTree || []).reduce(function (arr, m) {
      return arr.concat(m.children || []);
    }, []).sort(function (a, b) { return b.count - a.count; });
    State.methods = (meta.methods && meta.methods[State.subject]) || [];
    State.llm = meta.llm;
    State.emit('meta:updated', { me: State.me, stats: State.stats });
    if (nextKey !== prevKey) State.emit('auth:changed', State.me || null);
  };

  const TOKEN_KEY = 'mv_token';

  function cfg() { return window.MV_CONFIG || {}; }

  function apiUrl(path) {
    const base = String(cfg().apiBase || '').replace(/\/+$/, '');
    let url = base + path;
    const code = cfg().sharecode;
    if (code) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'sharecode=' + encodeURIComponent(code);
    return url;
  }

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  /* 静态资源（/uploads/xxx.png）走的是同一个网关，必须带 sharecode，
     否则会被当成未授权请求挡掉——讨论区图片「打不开」就是这个原因。 */
  function fileUrl(p) {
    const s = String(p || '');
    if (!s) return '';
    if (/^(data:|blob:|https?:\/\/)/i.test(s)) return s;
    const base = String(cfg().apiBase || '').replace(/\/+$/, '');
    let url = base + (s[0] === '/' ? s : '/' + s);
    const code = cfg().sharecode;
    if (code && url.indexOf('sharecode=') < 0) {
      url += (url.indexOf('?') >= 0 ? '&' : '?') + 'sharecode=' + encodeURIComponent(code);
    }
    return url;
  }

  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  /* 多标签页登录态同步：一个标签退出登录，另一个不能还显示已登录的信息。
     storage 事件只在「其它」标签页触发，因此不会造成本页循环更新。 */
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('storage', function (e) {
      if (e && e.key === TOKEN_KEY) State.emit('auth:changed', null);
    });
  }

  function authHeaders() {
    const t = token();
    // 同时带两种头：个别托管网关会过滤 Authorization
    return t ? { Authorization: 'Bearer ' + t, 'X-MV-Token': t } : {};
  }

  function sameOrigin() {
    return !String(cfg().apiBase || '').trim();
  }

  /**
   * 统一请求入口：自动带 token、序列化 body、解析 JSON、失败抛 ApiError。
   * @param {string} path 以 /api 开头的路径（sharecode 会自动拼上）
   * @param {RequestOptions} [options]
   * @returns {Promise<ApiOk & Object>}
   * @throws {ApiError}
   */
  const DEFAULT_TIMEOUT_MS = 20000;

  function apiError(message, kind, extra) {
    const err = new Error(message);
    err.kind = kind;
    if (extra) Object.assign(err, extra);
    return err;
  }

  /* 把底层异常翻译成用户能看懂的中文，区分「断网 / 超时 / 服务端 5xx / 未登录」。
     以前统一是「连不上服务器」，用户不知道该重试还是该重新登录。 */
  function describe(err) {
    if (!err) return '未知错误';
    if (err.kind === 'timeout') return err.message;
    if (err.kind === 'offline') return '网络已断开，恢复后重试';
    if (err.kind === 'network') return '连不上服务器，检查网络或后端地址';
    if (err.kind === 'server') return '服务器出错了（' + (err.status || 500) + '），稍后重试';
    if (err.kind === 'auth') return '登录已过期，请重新登录';
    return err.message || '请求失败';
  }

  /**
   * 统一请求入口：自动带 token、序列化 body、解析 JSON、失败抛 ApiError。
   * @param {string} path
   * @param {RequestOptions & {timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<ApiOk & Object>}
   */
  async function request(path, options) {
    const opt = options || {};
    const timeoutMs = opt.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(opt.timeoutMs);
    const opts = Object.assign({ method: 'GET', credentials: sameOrigin() ? 'include' : 'omit', cache: 'no-store' }, opt);
    delete opts.timeoutMs;
    opts.headers = Object.assign({}, authHeaders(), opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
      opts.headers['Content-Type'] = 'application/json';
    }

    const ctrl = new AbortController();
    let timedOut = false;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(function () { timedOut = true; try { ctrl.abort(); } catch (e) {} }, timeoutMs);
    }
    const outer = opt.signal;
    const onOuterAbort = function () { try { ctrl.abort(); } catch (e) {} };
    if (outer) {
      if (outer.aborted) onOuterAbort();
      else if (outer.addEventListener) outer.addEventListener('abort', onOuterAbort);
    }
    opts.signal = ctrl.signal;

    let res;
    try {
      res = await fetch(apiUrl(path), opts);
    } catch (e) {
      if (timedOut) throw apiError('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒），检查网络后重试', 'timeout');
      if (outer && outer.aborted) throw apiError('请求已取消', 'aborted');
      if (typeof navigator !== 'undefined' && navigator.onLine === false) throw apiError('网络已断开', 'offline');
      throw apiError('连不上服务器', 'network');
    } finally {
      if (timer) clearTimeout(timer);
      if (outer && outer.removeEventListener) outer.removeEventListener('abort', onOuterAbort);
    }

    const ct = res.headers.get('content-type') || '';
    if (ct.indexOf('application/json') < 0) {
      const err = apiError('服务返回了非 JSON 内容（' + res.status + '）', res.status >= 500 ? 'server' : 'client', { status: res.status });
      throw err;
    }
    let data;
    try { data = await res.json(); }
    catch (e) { throw apiError('服务返回数据损坏', 'server', { status: res.status }); }
    if (data.token) setToken(data.token);
    if (data.ok === false || !res.ok) {
      const kind = res.status === 401 ? 'auth' : (res.status >= 500 ? 'server' : 'client');
      const err = apiError(data.error || ('请求失败 ' + res.status), kind, { status: res.status, data: data });
      if (res.status === 401) {
        setToken('');
        State.me = null;
        State.emit('auth:changed', null);
      }
      throw err;
    }
    return data;
  }

  /**
   * 下载二进制（导出备份等）：走 blob，不经过 JSON 解析。
   * @param {string} path
   * @param {string} [filename]
   * @returns {Promise<void>}
   */
  async function download(path, filename) {
    const res = await fetch(apiUrl(path), { headers: authHeaders(), credentials: sameOrigin() ? 'include' : 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error('导出失败 ' + res.status);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'export.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  window.API = {
    State,
    request,
    get: (p) => request(p),
    post: (p, body) => request(p, { method: 'POST', body: body || {} }),
    url: apiUrl,
    fileUrl,
    sameOrigin,
    token,
    setToken,
    authHeaders,
    download,
    describe,
    DEFAULT_TIMEOUT_MS
  };
})();
