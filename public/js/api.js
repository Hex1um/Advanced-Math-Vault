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
    route: { name: 'library', params: {} }
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
  async function request(path, options) {
    const opts = Object.assign({ method: 'GET', credentials: sameOrigin() ? 'include' : 'omit', cache: 'no-store' }, options || {});
    opts.headers = Object.assign({}, authHeaders(), opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
      opts.headers['Content-Type'] = 'application/json';
    }
    let res;
    try {
      res = await fetch(apiUrl(path), opts);
    } catch (e) {
      throw new Error('连不上服务器，检查后端地址或网络');
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.indexOf('application/json') < 0) {
      throw new Error('服务返回异常（' + res.status + '）');
    }
    const data = await res.json();
    if (data.token) setToken(data.token);
    if (data.ok === false || !res.ok) {
      const err = new Error(data.error || ('请求失败 ' + res.status));
      err.status = res.status;
      err.data = data;
      if (res.status === 401) setToken('');
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
    download
  };
})();
