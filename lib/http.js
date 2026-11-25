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

function readBody(req, limit) {
  const max = limit || 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
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
  const clean = String(rel || '').replace(/^[/\\]+/, '');
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
  send,
  fail,
  sanitizeError,
  fail500,
  readBody,
  parseCookies,
  isHttps,
  clientIp,
  applyCors,
  resolveInside,
  serveUpload,
  serveStatic
};
