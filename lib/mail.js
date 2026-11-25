/**
 * 邮件通道（零依赖）
 *
 * 三种模式，按环境变量自动选择：
 *   1. MAIL_PROVIDER=resend   → Resend HTTP API（RESEND_API_KEY）
 *   2. MAIL_PROVIDER=http     → 自建 HTTP 邮件网关（MAIL_HTTP_URL / MAIL_HTTP_TOKEN）
 *   3. MAIL_PROVIDER=smtp     → 标准 SMTP（SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS，535/587 走 STARTTLS，465 直连 TLS）
 *   4. 都没配 → log 模式，验证码只写服务端日志（本地开发零门槛）
 *
 * 没显式指定 MAIL_PROVIDER 时按 RESEND_API_KEY > SMTP_HOST > MAIL_HTTP_URL 的顺序推断。
 * 这条链路只负责「把一封信发出去」，验证码生成、有效期、校验都在 server.js。
 */
'use strict';

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const DEFAULT_FROM = '数海晴岸 <no-reply@localhost>';

function env(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function resolveProvider() {
  const explicit = String(env('MAIL_PROVIDER', '')).toLowerCase().trim();
  if (explicit) return explicit;
  if (env('RESEND_API_KEY', '')) return 'resend';
  if (env('SMTP_HOST', '')) return 'smtp';
  if (env('MAIL_HTTP_URL', '')) return 'http';
  return 'log';
}

/* ------------------------------------------------------------ SMTP 客户端 */

/** 读一条（可能多行的）SMTP 应答。250-XXX 表示还有后续行。 */
function readReply(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => cleanup(new Error('SMTP 应答超时')), timeoutMs);
    function cleanup(err) {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      if (err) reject(err);
    }
    function onData(chunk) {
      buf += chunk.toString('utf8');
      // 逐行判断：最后一行必须是 "XYZ "（空格分隔），多行中间是 "XYZ-"
      const lines = buf.split(/\r?\n/).filter((l) => l.length > 2);
      if (!lines.length) return;
      const last = lines[lines.length - 1];
      if (/^\d{3} /.test(last)) {
        const code = Number(last.slice(0, 3));
        const text = lines.map((l) => l.slice(4)).join('\n');
        cleanup(null);
        resolve({ code, text });
      }
    }
    function onError(err) { cleanup(err); }
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

function write(socket, line) {
  return new Promise((resolve, reject) => {
    socket.write(line, (err) => (err ? reject(err) : resolve()));
  });
}

function dotStuff(body) {
  // RFC 5321：正文里以 . 开头的行要再加一个点
  return body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

function encodeHeader(value) {
  const s = String(value || '');
  // 非 ASCII 头按 RFC 2047 编码，避免中文主题被邮件客户端显示成乱码
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

function buildMessage({ from, to, subject, text }) {
  const domain = String(from).replace(/^.*<|>.*$/g, '').split('@')[1] || 'localhost';
  const msgId = '<' + crypto.randomBytes(12).toString('hex') + '@' + domain + '>';
  const body = dotStuff(String(text || ''));
  return [
    'From: ' + encodeHeader(from),
    'To: ' + encodeHeader(to),
    'Subject: ' + encodeHeader(subject),
    'Date: ' + new Date().toUTCString(),
    'Message-ID: ' + msgId,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body
  ].join('\r\n');
}

async function sendSmtp(opts, msg) {
  const host = opts.host;
  const port = Number(opts.port || 587);
  const secure = opts.secure === true || port === 465;
  const timeout = Number(opts.timeout || 15000);
  let socket = secure
    ? tls.connect({ host, port, servername: host, rejectUnauthorized: opts.rejectUnauthorized !== false })
    : net.connect({ host, port });
  socket.setTimeout(timeout);
  await new Promise((resolve, reject) => {
    socket.once(secure ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
    socket.once('timeout', () => reject(new Error('SMTP 连接超时')));
  });

  try {
    let r = await readReply(socket, timeout);
    if (r.code !== 220) throw new Error('SMTP 欢迎语异常: ' + r.code);

    const hello = (opts.heloName || 'localhost');
    await write(socket, 'EHLO ' + hello + '\r\n');
    r = await readReply(socket, timeout);
    if (r.code !== 250) throw new Error('EHLO 失败: ' + r.code + ' ' + r.text);
    let caps = r.text.toLowerCase();

    if (!secure && /starttls/.test(caps)) {
      await write(socket, 'STARTTLS\r\n');
      r = await readReply(socket, timeout);
      if (r.code !== 220) throw new Error('STARTTLS 失败: ' + r.code);
      socket = tls.connect({ socket, servername: host, rejectUnauthorized: opts.rejectUnauthorized !== false });
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
      await write(socket, 'EHLO ' + hello + '\r\n');
      r = await readReply(socket, timeout);
      if (r.code !== 250) throw new Error('STARTTLS 后 EHLO 失败: ' + r.code);
      caps = r.text.toLowerCase();
    }

    if (opts.user) {
      const pass = String(opts.pass || '');
      if (/auth[ =]plain/.test(caps)) {
        const token = Buffer.from('\u0000' + opts.user + '\u0000' + pass, 'utf8').toString('base64');
        await write(socket, 'AUTH PLAIN ' + token + '\r\n');
        r = await readReply(socket, timeout);
      } else {
        await write(socket, 'AUTH LOGIN\r\n');
        r = await readReply(socket, timeout);
        if (r.code !== 334) throw new Error('AUTH LOGIN 未被接受: ' + r.code);
        await write(socket, Buffer.from(opts.user, 'utf8').toString('base64') + '\r\n');
        r = await readReply(socket, timeout);
        if (r.code !== 334) throw new Error('AUTH 用户名未被接受: ' + r.code);
        await write(socket, Buffer.from(pass, 'utf8').toString('base64') + '\r\n');
        r = await readReply(socket, timeout);
      }
      if (r.code !== 235) throw new Error('SMTP 认证失败: ' + r.code + ' ' + r.text);
    }

    await write(socket, 'MAIL FROM:<' + opts.fromAddress + '>\r\n');
    r = await readReply(socket, timeout);
    if (r.code !== 250) throw new Error('MAIL FROM 被拒: ' + r.code + ' ' + r.text);

    await write(socket, 'RCPT TO:<' + msg.to + '>\r\n');
    r = await readReply(socket, timeout);
    if (r.code !== 250 && r.code !== 251) throw new Error('RCPT TO 被拒: ' + r.code + ' ' + r.text);

    await write(socket, 'DATA\r\n');
    r = await readReply(socket, timeout);
    if (r.code !== 354) throw new Error('DATA 被拒: ' + r.code);

    await write(socket, msg.raw + '\r\n.\r\n');
    r = await readReply(socket, timeout);
    if (r.code !== 250) throw new Error('邮件投递失败: ' + r.code + ' ' + r.text);

    try {
      await write(socket, 'QUIT\r\n');
    } catch (_) {}
    return { delivered: true };
  } finally {
    try { socket.destroy(); } catch (_) {}
  }
}

/* -------------------------------------------------------------- 对外接口 */

function createMailer(opts) {
  const cfg = opts || {};
  const provider = String(cfg.provider || resolveProvider()).toLowerCase();
  const from = cfg.from || env('MAIL_FROM', DEFAULT_FROM);
  const fromAddress = String(from).replace(/^.*<|>.*$/g, '') || 'no-reply@localhost';

  const smtp = {
    host: cfg.host || env('SMTP_HOST', ''),
    port: cfg.port || Number(env('SMTP_PORT', '587')),
    user: cfg.user !== undefined ? cfg.user : env('SMTP_USER', ''),
    pass: cfg.pass !== undefined ? cfg.pass : env('SMTP_PASS', ''),
    secure: String(env('SMTP_SECURE', '')).toLowerCase() === 'true',
    heloName: env('SMTP_HELO', '') || undefined,
    timeout: Number(env('SMTP_TIMEOUT', '15000'))
  };
  const resendKey = cfg.resendKey || env('RESEND_API_KEY', '');
  const httpUrl = cfg.httpUrl || env('MAIL_HTTP_URL', '');
  const httpToken = cfg.httpToken || env('MAIL_HTTP_TOKEN', '');

  function ready() {
    if (provider === 'smtp') return !!smtp.host;
    if (provider === 'resend') return !!resendKey;
    if (provider === 'http') return !!httpUrl;
    return false; // log 模式：能"发"，但只写服务端日志
  }

  function describe() {
    return {
      provider,
      ready: ready(),
      from,
      mode: ready() ? 'deliver' : 'log'
    };
  }

  async function send(input) {
    const to = String((input && input.to) || '').trim();
    const subject = String((input && input.subject) || '');
    const text = String((input && input.text) || '');
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return { delivered: false, provider, error: '收件地址不合法' };
    }
    if (!ready()) {
      // 日志模式：把验证码写给管理员，绝不回显到 HTTP 响应里
      console.log('[mail:log] ' + subject + ' -> ' + to + '\n' + text.replace(/^/gm, '  '));
      return { delivered: false, provider: 'log', mode: 'log' };
    }
    try {
      if (provider === 'resend') {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + resendKey },
          body: JSON.stringify({ from, to: [to], subject, text })
        });
        const bodyText = await res.text();
        if (!res.ok) return { delivered: false, provider, error: 'Resend ' + res.status + ' ' + bodyText.slice(0, 120) };
        let id = '';
        try { id = JSON.parse(bodyText).id || ''; } catch (_) {}
        return { delivered: true, provider, id };
      }
      if (provider === 'http') {
        const headers = { 'Content-Type': 'application/json' };
        if (httpToken) headers.Authorization = 'Bearer ' + httpToken;
        const res = await fetch(httpUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ from, to, subject, text })
        });
        const bodyText = await res.text();
        if (!res.ok) return { delivered: false, provider, error: 'HTTP 网关 ' + res.status + ' ' + bodyText.slice(0, 120) };
        return { delivered: true, provider };
      }
      if (provider === 'smtp') {
        const raw = buildMessage({ from, to, subject, text });
        await sendSmtp(Object.assign({}, smtp, { fromAddress }), { to, raw });
        return { delivered: true, provider };
      }
      return { delivered: false, provider, error: '未知邮件通道: ' + provider };
    } catch (e) {
      return { delivered: false, provider, error: e.message };
    }
  }

  return { provider, describe, send, ready };
}

module.exports = { createMailer, resolveProvider, buildMessage, dotStuff, encodeHeader };
