/**
 * 账号域路由组（v2.0.0 拆分）
 *
 * 注册 / 登录 / 登出 / 改密 / 个人信息 / 邮箱验证码。会话 token 只以 SHA-256 落盘。
 *
 * 签名统一为 (router, ctx)：router 负责路径匹配与中间件，ctx 提供 db / services / http。
 * 路由体沿用 server.js 时代的分支写法（pathname + method 判定），
 * 这样拆分本身不改变任何一条接口的行为，便于逐域审查与回归。
 */
'use strict';

const crypto = require('node:crypto');

module.exports = function registerAuthRoutes(router, ctx) {
  const { send, fail, readBody, clientIp, parseCookies, isHttps } = ctx.http;
  const {
    saveDb,
    hashPassword,
    verifyPassword,
    publicUser,
    bearerToken,
    sessionCookie,
    sessionKey,
    genCode,
    sendMailCode
  } = ctx.services;

  async function handle(rc) {
    const { req, res, pathname, query, user } = rc;
    const method = req.method;
    const db = ctx.db;
  /* ---- 账号 ---- */
  if (pathname === '/api/auth/register' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    if (name.length < 2 || name.length > 16) return fail(res, 400, '用户名需要 2-16 个字符');
    if (!/^[\w\u4e00-\u9fa5.-]+$/.test(name)) return fail(res, 400, '用户名只能包含中英文、数字、下划线');
    if (password.length < 8) return fail(res, 400, '密码至少 8 位');
    if (db.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) return fail(res, 409, '这个名字已经有人用了');
    const { salt, hash } = await hashPassword(password);
    // 公开部署后不能让「第一个注册的陌生人」自动当管理员：
    // 仅开发模式 + 库里确实没有任何 admin 时才自动授予；生产环境一律普通用户，
    // 管理员由 tools/create-admin.mjs 预设，避免删号后被人抢注 admin。
    const noAdmin = !db.users.some((x) => x.role === 'admin');
    const isFirst = noAdmin && db.users.length === 0 && process.env.NODE_ENV === 'development';
    const u = {
      id: crypto.randomUUID(),
      name,
      salt,
      passHash: hash,
      role: isFirst ? 'admin' : 'user',
      exp: 0,
      solved: {},
      activity: [],
      createdAt: new Date().toISOString()
    };
    db.users.push(u);
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[sessionKey(token)] = { uid: u.id, exp: Date.now() + 30 * 864e5 };
    saveDb();
    res.setHeader('Set-Cookie', sessionCookie(req, token));
    return send(res, 200, { ok: true, user: publicUser(u, true), token, isFirstAdmin: isFirst });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    const u = db.users.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!u || !(await verifyPassword(password, u))) return fail(res, 401, '用户名或密码不正确');
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[sessionKey(token)] = { uid: u.id, exp: Date.now() + 30 * 864e5 };
    saveDb();
    res.setHeader('Set-Cookie', sessionCookie(req, token));
    return send(res, 200, { ok: true, user: publicUser(u, true), token });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const token = bearerToken(req) || parseCookies(req)['mv_session'];
    if (token) {
      const k = sessionKey(token);
      if (db.sessions[k]) { delete db.sessions[k]; saveDb(); }
      else if (db.sessions[token]) { delete db.sessions[token]; saveDb(); }
    }
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/password' && method === 'POST') {
    if (!user) return fail(res, 401, '请先登录');
    const body = await readBody(req);
    const oldPwd = String(body.oldPassword || '');
    const newPwd = String(body.newPassword || '');
    if (!(await verifyPassword(oldPwd, user))) return fail(res, 400, '原密码不正确');
    if (newPwd.length < 8) return fail(res, 400, '新密码至少 8 位');
    const { salt, hash } = await hashPassword(newPwd);
    user.salt = salt;
    user.passHash = hash;
    // 其他会话失效
    const rawToken = bearerToken(req) || parseCookies(req)['mv_session'];
    const keep = rawToken ? sessionKey(rawToken) : '';
    for (const k of Object.keys(db.sessions)) {
      if (db.sessions[k] && db.sessions[k].uid === user.id && k !== keep && k !== rawToken) delete db.sessions[k];
    }
    saveDb(true);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/me' && method === 'GET') {
    return send(res, 200, { ok: true, user: publicUser(user, true), activity: (user && user.activity) || [] });
  }

  /* ---- 邮箱绑定：发验证码 ---- */
  if (pathname === '/api/me/email/send' && method === 'POST') {
    if (!user) return fail(res, 401, '请先登录');
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(res, 400, '邮箱格式不对');
    if (db.users.some((u) => u.id !== user.id && (u.email || '').toLowerCase() === email && u.emailVerified)) {
      return fail(res, 409, '这个邮箱已经被其他账号绑定了');
    }
    const code = genCode();
    db.emailCodes[user.id] = { email, code, exp: Date.now() + 5 * 60 * 1000, tries: 0 };
    saveDb();
    const r = await sendMailCode(email, code);
    // 验证码绝不随 HTTP 响应回显（否则谁能注册就能绑任意假邮箱、绕过发帖限流）。
    // 未配置邮件通道时验证码只写服务端日志，供站点管理员查看。
    return send(res, 200, {
      ok: true,
      delivered: !!r.delivered,
      provider: r.provider,
      message: r.delivered
        ? '验证码已发送到邮箱，5 分钟内有效'
        : (r.provider === 'log'
          ? '站点未接入邮件服务，验证码已写入服务端日志，请联系管理员'
          : '邮件发送失败，请稍后重试或联系管理员')
    });
  }

  /* ---- 邮箱绑定：校验 ---- */
  if (pathname === '/api/me/email/verify' && method === 'POST') {
    if (!user) return fail(res, 401, '请先登录');
    const body = await readBody(req);
    const code = String(body.code || '').trim();
    const rec = db.emailCodes[user.id];
    if (!rec) return fail(res, 400, '请先发送验证码');
    if (Date.now() > rec.exp) { delete db.emailCodes[user.id]; return fail(res, 400, '验证码已过期，请重新发送'); }
    if (rec.tries >= 5) { delete db.emailCodes[user.id]; return fail(res, 429, '尝试次数过多，请重新发送'); }
    rec.tries++;
    if (code !== rec.code) return fail(res, 400, '验证码不对');
    user.email = rec.email;
    user.emailVerified = true;
    user.emailVerifiedAt = new Date().toISOString();
    delete db.emailCodes[user.id];
    saveDb(true);
    return send(res, 200, { ok: true, user: publicUser(user, true) });
  }
  }

  for (const p of ['/api/auth/*', '/api/me', '/api/me/email/*']) router.all(p, handle);
  return handle;
};
