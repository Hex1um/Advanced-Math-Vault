/**
 * 错题本与复习域路由组（v2.0.0 拆分）
 *
 * FSRS 复习队列、错题备注、复习自评、判分申诉。
 *
 * 签名统一为 (router, ctx)：router 负责路径匹配与中间件，ctx 提供 db / services / http。
 * 路由体沿用 server.js 时代的分支写法（pathname + method 判定），
 * 这样拆分本身不改变任何一条接口的行为，便于逐域审查与回归。
 */
'use strict';

const tagTax = require('../tag-taxonomy');

module.exports = function registerWrongbookRoutes(router, ctx) {
  const { send, fail, readBody, clientIp, parseCookies, isHttps } = ctx.http;
  const {
    fsrs,
    saveDb,
    levelOf,
    excerptOf,
    logActivity,
    ai
  } = ctx.services;

  async function handle(rc) {
    const { req, res, pathname, query, user } = rc;
    const method = req.method;
    const db = ctx.db;
  /* ---- 判分申诉：对 AI 打分不服，转人工复核 ---- */
  if (pathname === '/api/submissions/appeal' && method === 'POST') {
    if (!user) return fail(res, 401, '请先登录');
    const body = await readBody(req);
    const sid = String(body.submissionId || '').trim();
    const reason = String(body.reason || '').trim();
    if (!sid) return fail(res, 400, '缺少提交记录');
    if (reason.length < 6) return fail(res, 400, '请写清申诉理由（至少 6 个字）');
    const sub = (db.submissions || []).find((x) => x.id === sid && x.uid === user.id);
    if (!sub) return fail(res, 404, '找不到这条提交记录');
    const dup = (db.feedbacks || []).find((f) => f.submissionId === sid && f.status === 'open');
    if (dup) return send(res, 200, { ok: true, id: dup.id, message: '这条已经在等人工复核了' });
    const fb = {
      id: db.meta.feedbackSeq++,
      code: sub.code,
      type: 'appeal',
      content: ('申诉判分：' + reason).slice(0, 2000),
      imageDesc: '',
      userId: user.id,
      userName: user.name,
      createdAt: new Date().toISOString(),
      status: 'open',
      ai: null,
      adminNote: '',
      handledAt: null,
      handlerName: '',
      submissionId: sid,
      submissionScore: sub.score || 0,
      submissionAt: sub.at || ''
    };
    db.feedbacks.push(fb);
    saveDb();
    logActivity(user, '对 ' + sub.code + ' 的判分提出申诉', sub.code);
    return send(res, 200, { ok: true, id: fb.id, message: '已转人工复核，结果会在反馈里回复' });
  }

  /* ---- 今日复习：间隔重复队列 ---- */
  if (pathname === '/api/my/review-today' && method === 'GET') {
    if (!user) return fail(res, 401, '请先登录');
    const now = Date.now();
    const wrong = user.wrong || {};
    const dueList = [];
    for (const [code, w] of Object.entries(wrong)) {
      const p = db.problems.find((x) => x.code === code && x.status === 'approved');
      if (!p) continue;
      if (!fsrs.isDue(w, now)) continue;
      dueList.push({ code, p, w, overdue: fsrs.overdueDays(w, now) });
    }
    // 逾期越久越优先；同逾期按稳定度低的优先（更容易忘的先复习）
    dueList.sort((a, b) => (b.overdue - a.overdue) || ((a.w.stability || 0) - (b.w.stability || 0)));
    const items = dueList.slice(0, 10).map((it) => ({
      code: it.code,
      title: it.p.title,
      difficulty: it.p.difficulty,
      tags: it.p.tags,
      intervalDays: it.w.intervalDays || 1,
      stability: it.w.stability || 0,
      state: it.w.state || 'new',
      overdueDays: it.overdue,
      lastScore: it.w.score || 0,
      tries: it.w.tries || 0
    }));
    return send(res, 200, {
      ok: true, items, due: dueList.length, total: Object.keys(wrong).length,
      archive: Object.keys(user.reviewArchive || {}).length
    });
  }

  /* ---- 错题本 ---- */
  if (pathname === '/api/wrongbook' && method === 'GET') {
    if (!user) return fail(res, 401, '登录后才有错题本');
    /* 学科过滤：默认 math，与 v2.6.0 的返回内容一致（那时只有数学题） */
    const subject = tagTax.subjectOf(query.subject);
    const out = [];
    for (const [code, v] of Object.entries(user.wrong || {})) {
      const p = db.problems.find((x) => x.code === code);
      if (!p || p.status !== 'approved') continue;
      if (tagTax.subjectOf(p.subject) !== subject) continue;
      out.push({
        code: p.code, subject: tagTax.subjectOf(p.subject), title: p.title, tags: p.tags, difficulty: p.difficulty,
        thinking: p.thinking, calc: p.calc,
        levelColor: levelOf(p.difficulty).color,
        myScore: v.score, tries: v.tries, at: v.at,
        intervalDays: v.intervalDays || 1,
        nextReviewAt: v.nextReviewAt || 0,
        stability: v.stability || 0,
        difficulty: v.difficulty || 5,
        state: v.state || 'new',
        lapses: v.lapses || 0,
        reps: v.reps || 0,
        overdueDays: fsrs.overdueDays(v, Date.now()),
        note: v.note || '',
        lastResult: v.lastResult || '',
        due: (v.nextReviewAt || 0) <= Date.now(),
        best: (user.best[code] || {}).score || v.score,
        solved: !!(user.solved[code] && user.solved[code].done),
        excerpt: excerptOf(p.statement, 100)
      });
    }
    out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return send(res, 200, { ok: true, total: out.length, items: out });
  }

  /* ---- 错题个人备注：只改备注，不影响复习排期 ---- */
  const noteMatch = pathname.match(/^\/api\/wrongbook\/([A-Za-z0-9-]+)\/note$/);
  if (noteMatch && method === 'POST') {
    if (!user) return fail(res, 401, '请先登录');
    const code = noteMatch[1].toUpperCase();
    const card = user.wrong && user.wrong[code];
    if (!card) return fail(res, 404, '这道题不在你的错题本里');
    const body = await readBody(req);
    const note = String(body.note == null ? '' : body.note).trim().slice(0, 200);
    if (note) card.note = note;
    else delete card.note;
    saveDb();
    return send(res, 200, { ok: true, note: note });
  }

  /* ---- 错题复习自评（FSRS）：again / hard / good / easy ---- */
  const reviewMatch = pathname.match(/^\/api\/wrongbook\/([A-Za-z0-9-]+)\/review$/);
  if (reviewMatch && method === 'POST') {
    if (!user) return fail(res, 401, '请先登录');
    const code = reviewMatch[1].toUpperCase();
    const p = db.problems.find((x) => x.code === code);
    if (!p || p.status !== 'approved') return fail(res, 404, '题目不存在');
    const card = user.wrong && user.wrong[code];
    if (!card) return fail(res, 404, '这道题不在你的错题本里（已掌握出本，或从未做错）');
    const body = await readBody(req);
    const next = Object.assign({}, card, fsrs.schedule(card, body.rating, Date.now()));
    const note = String(body.note == null ? '' : body.note).trim().slice(0, 200);
    if (note) next.note = note;

    let graduated = false;
    if (next.intervalDays >= 8) {
      user.reviewArchive = user.reviewArchive || {};
      user.reviewArchive[code] = {
        intervalDays: next.intervalDays,
        stability: next.stability,
        graduatedAt: Date.now()
      };
      delete user.wrong[code];
      graduated = true;
    } else {
      user.wrong[code] = next;
    }
    logActivity(user, '复习 ' + code + '（' + (next.lastGrade || '') + '，' + next.intervalDays + ' 天后）', code);
    saveDb();
    return send(res, 200, {
      ok: true,
      code: code,
      graduated: graduated,
      intervalDays: next.intervalDays,
      nextReviewAt: next.nextReviewAt,
      stability: next.stability,
      difficulty: next.difficulty,
      state: next.state,
      rating: next.lastGrade || ''
    });
  }
  }

  for (const p of ['/api/wrongbook', '/api/wrongbook/*', '/api/my/review-today', '/api/submissions/appeal']) router.all(p, handle);
  return handle;
};
