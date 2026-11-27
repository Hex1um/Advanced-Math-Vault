'use strict';
/**
 * HTTP 基础层：响应封装、请求体解析、Cookie、CORS、静态文件与错误脱敏。
 *
 * 从 server.js 抽出来（P2-1 Step 1）的原因：
 *   - 这几个函数是安全边界所在（路径穿越、伪造 X-Forwarded-Proto、500 泄露内部堆栈），
 *     单独成文件才能被单测直接盯住；
 *   - 零第三方依赖，只用 node 内置模块。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
};

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function fail(res, status, msg) {
  send(res, status, { ok: false, error: msg });
}

/**
 * 500 响应体：对客户端只说「服务器内部错误」+ 一个短 reqId，
 * 完整堆栈只进服务端日志。开发模式下附 detail，便于本地排错。
 */
function sanitizeError(e, opts) {
  const o = opts || {};
  const reqId = o.reqId || crypto.randomBytes(4).toString('hex');
  const payload = { ok: false, error: '服务器内部错误', reqId: reqId };
  if (o.dev) payload.detail = String((e && e.message) || e).slice(0, 500);
  return payload;
}

function fail500(res, e, opts) {
  const o = opts || {};
  const payload = sanitizeError(e, o);
  if (typeof o.log === 'function') {
    o.log('[api]', payload.reqId, o.tag || '', (e && e.stack) || e);
  }
  if (!res.headersSent) send(res, 500, payload);
  else { try { res.end(); } catch (_) {} }
  return payload;
}

/* 查询参数取整数：`?page=abc` / `?size=1e9` 这类脏参数以前会算成 NaN，
   结果是 slice(NaN) 返回空列表（看起来像「题库没数据」），或者不封顶的 size
   直接把整库塞进响应。统一走这个函数：小数点向下取整，非数字回落默认值，
   再夹到 [min, max]。 */
function intParam(value, def, min, max) {
  const n = Math.floor(Number(value));
  let out = Number.isFinite(n) ? n : def;
  if (Number.isFinite(min) && out < min) out = min;
  if (Number.isFinite(max) && out > max) out = max;
  return out;
}

/**
 * 带 HTTP 状态码的错误：路由层只管 throw，server.js 统一翻译成响应。
 *
 * 为什么需要它：`readBody` 以前抛的是裸 Error，路由层 40+ 处 `await readBody(req)`
 * 都没有 try/catch，异常一路冒到 server.js 的 fail500 —— 于是「用户提交了脏 JSON」
 * 这种客户端错误被回成 500「服务器内部错误 + reqId」，服务端还记一条假 error 日志，
 * 真正的 5xx 被噪声淹没。超限同理：应该是 413，实际是 500。
 */
class HttpError extends Error {
  constructor(status, message, opts) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    // 只对「客户端能看懂」的 4xx 回显 message；5xx 仍走 fail500 脱敏
    this.expose = (opts && opts.expose !== undefined) ? !!opts.expose : status < 500;
  }
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 三点约定（都是以前踩过的坑）：
 *   1. 一次性结算：reject 之后 end/error 仍可能触发，用 settled 挡住重复 resolve/reject；
 *   2. 超限不立刻 destroy：先 pause 把 socket 兜住，让 server.js 有机会把 413 响应写出去，
 *      写完再断开。直接 destroy 的话客户端只看到 ECONNRESET，连「为什么被拒」都拿不到；
 *   3. 错误带状态码：400（脏 JSON / 空 body 解析失败）、413（超限）、400（传输中断）。
 */
function readBody(req, limit) {
  const max = limit || 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      fn(val);
    };

    function onData(c) {
      if (settled) return;
      size += c.length;
      if (size > max) {
        // 停止收流但不断连接：响应还能原路发回去
        try { req.pause(); } catch (e) { /* 流已结束 */ }
        finish(reject, new HttpError(413, '请求体过大（上限 ' + max + ' 字节）'));
        return;
      }
      chunks.push(c);
    }

    function onEnd() {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return finish(resolve, {});
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) { return finish(reject, new HttpError(400, '请求体不是合法 JSON')); }
      /* `null` / 数字 / 字符串虽然都是合法 JSON，但路由层一律按对象取字段
         （body.name），拿到它们只会变成 TypeError → 500。在入口就挡掉。 */
      if (parsed === null || typeof parsed !== 'object') {
        return finish(reject, new HttpError(400, '请求体必须是 JSON 对象'));
      }
      return finish(resolve, parsed);
    }

    function onError() {
      // 客户端中途断开：不算服务端故障
      finish(reject, new HttpError(400, '请求传输中断'));
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch (e) { out[k] = part.slice(i + 1).trim(); }
  });
  return out;
}

/** 只有显式 TRUST_PROXY 时才信 X-Forwarded-*：否则任何客户端都能自称 https / 换 IP。 */
function isHttps(req, opts) {
  const trust = !!(opts && opts.trustProxy);
  if (trust) {
    const chain = String(req.headers['x-forwarded-proto'] || '').split(',');
    const proto = String(chain[0] || '').trim().toLowerCase();
    if (proto === 'https') return true;
    if (proto === 'http') return false;
  }
  return !!(req.socket && req.socket.encrypted);
}

function clientIp(req, opts) {
  const trust = !!(opts && opts.trustProxy);
  if (trust) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) {
      const first = String(fwd).split(',')[0].trim();
      if (/^[0-9a-fA-F:.]+$/.test(first)) return first;
    }
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function applyCors(req, res, allowedOrigins) {
  const list = Array.isArray(allowedOrigins) ? allowedOrigins : ['*'];
  const origin = req.headers.origin || '';
  let allow = '';
  if (list.includes('*')) allow = '*';
  else if (origin && list.includes(origin)) allow = origin;
  if (allow) {
    res.setHeader('Access-Control-Allow-Origin', allow);
    res.setHeader('Vary', 'Origin');
    // 通配符与凭据不能同时出现（浏览器会直接拒绝），只有命中具体来源时才允许带凭据
    if (allow !== '*') res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-MV-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * 把相对路径安全地解析到 baseDir 之内。
 * 直接 `full.startsWith(PUBLIC_DIR)` 会让 public_backup/ 这类同前缀兄弟目录漏过去，
 * 必须比较 `base + path.sep`。
 * @returns {?string} 绝对路径；越界返回 null
 */
function resolveInside(baseDir, rel) {
  const base = path.resolve(baseDir);
  // 反斜杠统一成正斜杠：Windows 上 \ 是分隔符，Linux 上只是普通字符。
  // 不归一化的话，`/..\..\etc\passwd` 在 Linux 会被当成合法文件名放过去。
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^[/]+/, '');
  const target = path.resolve(base, clean);
  if (target === base) return target;
  if (!target.startsWith(base + path.sep)) return null;
  return target;
}

function serveUpload(res, pathname, opts) {
  const o = opts || {};
  const name = path.basename(pathname);
  if (!/^[A-Za-z0-9]+\.(png|jpg|jpeg|webp|gif)$/i.test(name)) return fail(res, 404, '图片不存在');
  const file = resolveInside(o.uploadDir || path.join(o.dataDir || 'data', 'uploads'), name);
  if (!file) return fail(res, 404, '图片不存在');
  fs.readFile(file, (err, data) => {
    if (err) return fail(res, 404, '图片不存在');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400'
    });
    res.end(data);
  });
}

function serveStatic(req, res, pathname, opts) {
  const o = opts || {};
  if (pathname.indexOf('/uploads/') === 0) return serveUpload(res, pathname, o);
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {
    return fail(res, 400, '请求路径编码不合法');
  }
  if (rel === '/') rel = '/index.html';
  const filePath = resolveInside(o.publicDir, rel);
  if (!filePath) return fail(res, 403, '禁止访问');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (req.headers.accept && req.headers.accept.includes('text/html')) {
        const idx = path.join(o.publicDir, 'index.html');
        return fs.readFile(idx, (e2, html) => {
          if (e2) return fail(res, 404, '页面不存在');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(html);
        });
      }
      return fail(res, 404, '资源不存在');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(data);
  });
}

module.exports = {
  MIME,
  HttpError,
  send,
  fail,
  sanitizeError,
  fail500,
  readBody,
  intParam,
  parseCookies,
  isHttps,
  clientIp,
  applyCors,
  resolveInside,
  serveUpload,
  serveStatic
};
