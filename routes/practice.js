/**
 * 刷题域路由组（v2.0.0 拆分）
 *
 * 每日一积、顺序刷 / 随机刷、薄弱考点定向推题。
 *
 * 签名统一为 (router, ctx)：router 负责路径匹配与中间件，ctx 提供 db / services / http。
 * 路由体沿用 server.js 时代的分支写法（pathname + method 判定），
 * 这样拆分本身不改变任何一条接口的行为，便于逐域审查与回归。
 */
'use strict';

const tagTax = require('../tag-taxonomy');

module.exports = function registerPracticeRoutes(router, ctx) {
  const { send, fail, readBody, clientIp, parseCookies, isHttps } = ctx.http;
  const {
    DIFF_MAX,
    visibleProblem,
    todayKey,
    dailyProblem,
    recentDaily,
    weakMainTags
  } = ctx.services;

  async function handle(rc) {
    const { req, res, pathname, query, user } = rc;
    const method = req.method;
    const db = ctx.db;
  /* ---- 每日一题 ---- */
  if (pathname === '/api/daily' && method === 'GET') {
    /* 每日一积（数学）/ 每日一物（物理）：同一接口按 subject 分流，
       不传 subject 时行为与 v2.6.0 完全一致。 */
    const subject = tagTax.subjectOf(query.subject);
    const p = dailyProblem(null, subject);
    return send(res, 200, {
      ok: true,
      date: todayKey(),
      subject,
      problem: p ? Object.assign(visibleProblem(p, user), { statement: p.statement }) : null,
      recent: recentDaily(8, user, subject)
    });
  }

  /* ---- 顺序刷 / 随机刷 ---- */
  if (pathname === '/api/practice' && method === 'GET') {
    const mode = query.mode === 'random' ? 'random' : 'seq';
    const tags = String(query.tags || '').split(',').map((x) => x.trim()).filter(Boolean);
    const mainTag = String(query.main || '').trim();
    const dmin = Number(query.dmin || 1);
    const dmax = Number(query.dmax || DIFF_MAX);
    const focus = String(query.focus || '').trim();
    /* 学科：不传按数学；每日一积（/api/daily）保持纯数学不动 */
    const subject = tagTax.subjectOf(query.subject);
    const method = String(query.method || '').trim();
    let pool = db.problems.filter((p) => p.status === 'approved' && tagTax.subjectOf(p.subject) === subject);
    if (mainTag) pool = pool.filter((p) => p.mainTag === mainTag);
    if (tags.length) pool = pool.filter((p) => p.tags.some((t) => tags.includes(t)));
    if (method) pool = pool.filter((p) => ((p.physicsMeta && p.physicsMeta.methods) || []).includes(method));
    pool = pool.filter((p) => p.difficulty >= dmin && p.difficulty <= dmax);
    if (user) {
      const solved = user.solved || {};
      pool = pool.filter((p) => !(solved[p.code] && solved[p.code].done));
    }
    /* 薄弱考点定向推题：按九主标签的通过率挑最差的几个，优先出这些考点的未做题 */
    let focusTags = [];
    if (focus === 'weak') {
      if (!user) return fail(res, 401, '登录后才能按薄弱考点推题');
      focusTags = weakMainTags(user, 3);
      if (focusTags.length) {
        const set = new Set(focusTags);
        const narrowed = pool.filter((p) => set.has(p.mainTag));
        if (narrowed.length) pool = narrowed;
      }
    }
    if (!pool.length) return send(res, 200, { ok: true, code: null, remaining: 0, focus, focusTags });
    pool.sort((a, b) => a.code.localeCompare(b.code));
    let pick;
    if (mode === 'random') {
      pick = pool[Math.floor(Math.random() * pool.length)];
    } else {
      const after = String(query.after || '').toUpperCase();
      const idx = after ? pool.findIndex((p) => p.code > after) : 0;
      pick = pool[idx < 0 ? 0 : idx];
    }
    return send(res, 200, { ok: true, code: pick.code, remaining: pool.length, mode, focus, focusTags, mainTag: pick.mainTag });
  }
  }

  for (const p of ['/api/daily', '/api/practice']) router.all(p, handle);
  return handle;
};
