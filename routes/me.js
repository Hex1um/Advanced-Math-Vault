/**
 * 个人中心域路由组（v2.0.0 拆分）
 *
 * 投稿、我的投稿、已做出题目、最近作答记录。
 *
 * 签名统一为 (router, ctx)：router 负责路径匹配与中间件，ctx 提供 db / services / http。
 * 路由体沿用 server.js 时代的分支写法（pathname + method 判定），
 * 这样拆分本身不改变任何一条接口的行为，便于逐域审查与回归。
 */
'use strict';

module.exports = function registerMeRoutes(router, ctx) {
  const { send, fail, readBody, clientIp, parseCookies, isHttps } = ctx.http;
  const {
    saveDb,
    findDuplicateProblem,
    normalizeProblem,
    nextProblemCode,
    logActivity
  } = ctx.services;

  async function handle(rc) {
    const { req, res, pathname, query, user } = rc;
    const method = req.method;
    const db = ctx.db;
  /* ---- 投稿 ---- */
  if (pathname === '/api/submit' && method === 'POST') {
    if (!user) return fail(res, 401, '请先登录再投稿');
    const body = await readBody(req);
    const item = normalizeProblem(body);
    if (!item) return fail(res, 400, '标题和题干必填');
    const dup = findDuplicateProblem(item);
    if (dup) {
      return send(res, 409, {
        ok: false,
        error: '这道题与已有题目「' + dup.code + ' ' + dup.title + '」高度重合（相似度 ' + dup.score + '%），请先确认不是重复投稿。',
        duplicate: dup
      });
    }
    item.code = nextProblemCode();
    item.authorId = user.id;
    item.authorName = user.name;
    db.problems.push(item);
    logActivity(user, '投稿 ' + item.code + ' 待审核', item.code);
    saveDb();
    return send(res, 200, { ok: true, code: item.code });
  }

  if (pathname === '/api/my/submissions' && method === 'GET') {
    if (!user) return fail(res, 401, '请先登录');
    const items = db.problems
      .filter((p) => p.authorId === user.id && p.status !== 'approved')
      .map((p) => ({ code: p.code, title: p.title, status: p.status, rejectReason: p.rejectReason, createdAt: p.createdAt }));
    return send(res, 200, { ok: true, items });
  }

  if (pathname === '/api/my/solved' && method === 'GET') {
    if (!user) return fail(res, 401, '请先登录');
    const solved = user.solved || {};
    const items = Object.keys(solved)
      .filter((code) => solved[code] && solved[code].done)
      .map((code) => {
        const p = db.problems.find((x) => x.code === code);
        return {
          code,
          title: p ? p.title : code,
          at: solved[code].at,
          revealed: !!solved[code].revealed,
          askedAI: !!solved[code].askedAI
        };
      })
      .sort((a, b) => (b.at || 0) - (a.at || 0));
    return send(res, 200, { ok: true, items });
  }

  /* 最近作答（含没通过线的），让「我的记录」能看到每次提交 */
  if (pathname === '/api/my/attempts' && method === 'GET') {
    if (!user) return send(res, 200, { ok: true, items: [] });
    const items = db.submissions
      .filter((x) => x.uid === user.id)
      .slice(-40)
      .reverse()
      .map((x) => {
        const p = db.problems.find((q) => q.code === x.code);
        return {
          id: x.id, code: x.code,
          title: p ? p.title : x.code,
          score: x.score, verdict: x.verdict, mode: x.mode,
          judgedBy: x.judgedBy || '', at: x.at,
          comment: String(x.comment || '').slice(0, 120)
        };
      });
    return send(res, 200, { ok: true, items });
  }
  }

  for (const p of ['/api/submit', '/api/my/submissions', '/api/my/solved', '/api/my/attempts']) router.all(p, handle);
  return handle;
};
