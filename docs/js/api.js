/* 极简 API 客户端 + 全局状态（支持跨域 token，静态托管上也能用） */
(function () {
  'use strict';

  const State = {
    me: null,
    meta: null,
    tags: [],
    tagTree: [],
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
