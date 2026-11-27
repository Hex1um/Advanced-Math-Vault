/**
 * 口令哈希、会话签发与身份识别（cookie / Bearer 双通道）
 *
 * 从 lib/core.js 抽出来的原因：这是安全边界最集中的一段 ——
 * 口令只存 scrypt 哈希并用 timingSafeEqual 比对、会话表只存 token 的 SHA-256、
 * Cookie 属性（HttpOnly / SameSite / Secure / Priority）都是攻防结论。
 * 混在业务闭包里时，改一处业务逻辑很容易顺手把这里改坏。
 */
'use strict';

const crypto = require('crypto');
const { TUNING } = require('./config');
const { levelInfo } = require('./gamify');

module.exports = function createAuth(deps) {
  const d = deps || {};
  const getDb = d.getDb || function () { throw new Error('auth 需要 getDb'); };
  const parseCookies = d.parseCookies || function () { return {}; };
  const isHttps = d.isHttps || function () { return false; };
  const TRUST_PROXY = !!d.trustProxy;

  /* scrypt 是 CPU 密集操作：同步版（scryptSync）会把整个事件循环按住几十毫秒，
     并发登录几个就能让全站卡住。改成 promisify 版本，成本参数与历史库保持一致
     （Node 默认 N=16384, r=8, p=1），老哈希仍可正常校验。 */
  const scryptAsync = require('util').promisify(crypto.scrypt);

  async function hashPassword(password, salt) {
    const s = salt || crypto.randomBytes(16).toString('hex');
    const buf = await scryptAsync(String(password), s, TUNING.SCRYPT_KEYLEN);
    return { salt: s, hash: Buffer.from(buf).toString('hex') };
  }

  async function verifyPassword(password, user) {
    try {
      const buf = await scryptAsync(String(password), user.salt, TUNING.SCRYPT_KEYLEN);
      const stored = Buffer.from(user.passHash, 'hex');
      return buf.length === stored.length && crypto.timingSafeEqual(buf, stored);
    } catch (e) { return false; }
  }

  function publicUser(u, withPrivate) {
    if (!u) return null;
    const li = levelInfo(u.exp);
    const solvedMap = u.solved || {};
    // 只统计真正做出来的（≥80 分），做过但没过的单独给 attempts
    const doneCount = Object.keys(solvedMap).filter((k) => solvedMap[k] && solvedMap[k].done).length;
    const out = {
      id: u.id, name: u.name, role: u.role || 'user',
      exp: u.exp || 0, level: li.level, levelProgress: li.progress,
      solvedCount: doneCount,
      attempts: u.attempts || 0,
      createdAt: u.createdAt
    };
    // 邮箱只给本人和后台看；排行榜/公共列表默认不带
    if (withPrivate) {
      out.email = u.email || '';
      out.emailVerified = !!u.emailVerified;
    }
    return out;
  }

  function bearerToken(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+([A-Za-z0-9]+)$/.exec(h);
    if (m) return m[1];
    // 有些托管网关会吃掉 Authorization 头，这里再认一个自定义头
    const alt = req.headers['x-mv-token'];
    if (alt && /^[A-Za-z0-9]+$/.test(String(alt))) return String(alt);
    // 不再接受 ?tk= query：token 会进浏览器历史、反代日志和 Referer
    return '';
  }

  // 默认不信任 X-Forwarded-For / X-Forwarded-Proto：客户端伪造它就能换限流桶、
  // 骗到 Secure Cookie。只有部署在可信反向代理后、显式 TRUST_PROXY=1 才解析。


  function sessionCookie(req, token, maxAge) {
    const parts = [
      'mv_session=' + token,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=' + (maxAge === undefined ? TUNING.SESSION_MAX_AGE : maxAge)
    ];
    if (isHttps(req, { trustProxy: TRUST_PROXY }) && Number(maxAge) !== 0) parts.push('Secure');
    /* Priority=High：浏览器清理存储时优先保留会话 Cookie（Chrome/Safari 支持，其余忽略） */
    parts.push('Priority=High');
    return parts.join('; ');
  }

  /* 会话表只存 token 的 SHA-256：备份文件或误提交的 db.json 泄露时，
     攻击者拿到哈希也无法反推 token 接管会话。
     老库里仍有明文 key，读取时两者都认（写入永远走哈希），过期后自然消失。 */
  function sessionKey(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  function currentUser(req) {
    const token = bearerToken(req) || parseCookies(req)['mv_session'];
    if (!token) return null;
    const db = getDb();
    const s = db.sessions[sessionKey(token)] || db.sessions[token];
    if (!s || s.exp < Date.now()) return null;
    const u = db.users.find((x) => x.id === s.uid);
    return u || null;
  }

  return {
    hashPassword: hashPassword,
    verifyPassword: verifyPassword,
    sessionKey: sessionKey,
    bearerToken: bearerToken,
    sessionCookie: sessionCookie,
    currentUser: currentUser,
    publicUser: publicUser
  };
};
