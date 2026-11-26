/**
 * 学习分析域路由组（v2.0.0 拆分）
 *
 * 考点统计 + 刷题热力图 + 掌握度诊断 + 薄弱点靶向推荐。
 *
 * 签名统一为 (router, ctx)：router 负责路径匹配与中间件，ctx 提供 db / services / http。
 * 路由体沿用 server.js 时代的分支写法（pathname + method 判定），
 * 这样拆分本身不改变任何一条接口的行为，便于逐域审查与回归。
 */
'use strict';

module.exports = function registerAnalyticsRoutes(router, ctx) {
  const { send, fail, readBody, clientIp, parseCookies, isHttps } = ctx.http;
  const {
    tagTax,
    todayKey,
    weakMainTags
  } = ctx.services;

  async function handle(rc) {
    const { req, res, pathname, query, user } = rc;
    const method = req.method;
    const db = ctx.db;
  /* ---- 我的考点统计：按标签聚合 + 薄弱考点 + 推荐题 ---- */
  if (pathname === '/api/my/stats' && method === 'GET') {
    if (!user) return fail(res, 401, '请先登录');
    /* 学科隔离：数学与物理的主标签是两套互不重叠的命名空间，
       混在一张能力图里会出现「力学 0 分」这种无意义空行。 */
    const subject = tagTax.subjectOf(query.subject);
    const spec = tagTax.SUBJECTS[subject];
    const solvedMap = user.solved || {};
    const bestMap = user.best || {};
    const agg = new Map();
    const mainAgg = new Map(spec.mainTags.map((t) => [t, { tag: t, attempts: 0, passed: 0, scoreSum: 0 }]));
    let attempts = 0, passedCount = 0, scoreSum = 0;
    for (const [code, rec] of Object.entries(solvedMap)) {
      const p = db.problems.find((x) => x.code === code);
      if (!p) continue;
      if (tagTax.subjectOf(p.subject) !== subject) continue;
      const sc = (bestMap[code] && bestMap[code].score) || (rec.done ? 100 : 0);
      attempts++; scoreSum += sc;
      if (rec.done) passedCount++;
      for (const t of p.tags || []) {
        const o = agg.get(t) || { tag: t, attempts: 0, passed: 0, scoreSum: 0 };
        o.attempts++; if (rec.done) o.passed++; o.scoreSum += sc;
        agg.set(t, o);
      }
      const mt = mainAgg.get(p.mainTag || '综合');
      if (mt) { mt.attempts++; if (rec.done) mt.passed++; mt.scoreSum += sc; }
    }
    const tags = [...agg.values()].map((o) => ({
      tag: o.tag, attempts: o.attempts, passed: o.passed,
      rate: Math.round((o.passed / o.attempts) * 100),
      avgScore: Math.round(o.scoreSum / o.attempts)
    })).sort((a, b) => b.attempts - a.attempts);
    const mainTags = [...mainAgg.values()].map((o) => ({
      tag: o.tag, attempts: o.attempts, passed: o.passed,
      rate: o.attempts ? Math.round((o.passed / o.attempts) * 100) : 0,
      avgScore: o.attempts ? Math.round(o.scoreSum / o.attempts) : 0
    }));
    const weakest = tags.slice()
      .filter((t) => t.attempts >= 1 && t.passed < t.attempts)
      .sort((a, b) => a.rate - b.rate || a.avgScore - b.avgScore)
      .slice(0, 3);
    const recommend = [];
    for (const w of weakest) {
      for (const p of db.problems) {
        if (recommend.length >= 6) break;
        if (p.status !== 'approved') continue;
        if (tagTax.subjectOf(p.subject) !== subject) continue;
        if (!(p.tags || []).includes(w.tag)) continue;
        if (solvedMap[p.code] && solvedMap[p.code].done) continue;
        if (recommend.some((r) => r.code === p.code)) continue;
        recommend.push({ code: p.code, title: p.title, difficulty: p.difficulty, tag: w.tag });
      }
    }
    const weakMain = weakMainTags(user, 3);
    const mainRecommend = [];
    for (const tag of weakMain) {
      let n = 0;
      for (const p of db.problems) {
        if (n >= 2 || mainRecommend.length >= 6) break;
        if (p.status !== 'approved' || (p.mainTag || '综合') !== tag) continue;
        if (solvedMap[p.code] && solvedMap[p.code].done) continue;
        if (mainRecommend.some((r) => r.code === p.code)) continue;
        mainRecommend.push({ code: p.code, title: p.title, difficulty: p.difficulty, mainTag: tag });
        n++;
      }
    }
    return send(res, 200, {
      ok: true,
      summary: {
        attempts, passed: passedCount, solved: passedCount,
        rate: attempts ? Math.round((passedCount / attempts) * 100) : 0,
        avgScore: attempts ? Math.round(scoreSum / attempts) : 0,
        wrong: Object.keys(user.wrong || {}).length
      },
      tags, mainTags, weakest, recommend, weakMain, mainRecommend,
      subject: subject
    });
  }
  }

  /* ---- 学习分析总览：刷题热力图 + 九大主考点掌握度 + 薄弱点靶向推荐 ---- */
  router.get('/api/analytics/overview', async ({ res, user, query }) => {
    if (!user) return fail(res, 401, '登录后才有学习分析');
    const db = ctx.db;
    const subject = tagTax.subjectOf(query && query.subject);
    const subs = (db.submissions || []).filter((s) => (s.uid || s.userId) === user.id);
    const probMap = new Map((db.problems || []).map((p) => [p.code, p]));

    // 1. 过去 180 天每日刷题量（按 UTC+8 切日，避免晚上 8 点后算到前一天）
    const dailyMap = new Map();
    const now = Date.now();
    const cutoff = now - 180 * 86400000;

    // 2. 九大主考点掌握度
    const tagStats = new Map();
    const solvedSet = new Set();

    for (const s of subs) {
      const ts = Date.parse(s.at || s.createdAt || '') || 0;
      if (ts >= cutoff) {
        const day = new Date(ts + 8 * 3600000).toISOString().slice(0, 10);
        dailyMap.set(day, (dailyMap.get(day) || 0) + 1);
      }
      const p = probMap.get(s.code || s.problemCode);
      if (!p) continue;
      if (tagTax.subjectOf(p.subject) !== subject) continue;
      if (s.score >= 80) solvedSet.add(p.code);

      const mainTag = p.mainTag || '综合';
      const st = tagStats.get(mainTag) || { mainTag, attempts: 0, correct: 0, solved: new Set() };
      st.attempts++;
      if (s.score >= 80) { st.correct++; st.solved.add(p.code); }
      tagStats.set(mainTag, st);
    }

    const mastery = [...tagStats.values()]
      .map((st) => {
        const accuracy = st.attempts ? st.correct / st.attempts : 0;
        const coverage = Math.min(1, st.solved.size / 15);
        // 综合掌握度：正确率 70% + 覆盖度平滑项 30%
        const score = Math.round((accuracy * 0.7 + coverage * 0.3) * 100);
        return {
          mainTag: st.mainTag,
          attempts: st.attempts,
          uniqueSolved: st.solved.size,
          accuracy: Number((accuracy * 100).toFixed(1)),
          score
        };
      })
      .sort((a, b) => a.score - b.score);

    // 3. 靶向推荐：掌握度最低的两个主考点里，挑没做过的中等难度题
    const weakTags = new Set(mastery.slice(0, 2).map((m) => m.mainTag));
    const recommended = (db.problems || [])
      .filter((p) => p.status === 'approved' && !solvedSet.has(p.code) &&
        tagTax.subjectOf(p.subject) === subject &&
        (weakTags.size === 0 || weakTags.has(p.mainTag)) && p.difficulty >= 4 && p.difficulty <= 8)
      .slice(0, 6)
      .map((p) => ({ code: p.code, title: p.title, mainTag: p.mainTag, difficulty: p.difficulty }));

    // 4. 连续打卡（今日/最长）
    const days = [...dailyMap.keys()].sort();
    let bestStreak = 0;
    let run = 0;
    let prev = '';
    for (const d of days) {
      const gap = prev ? Math.round((Date.parse(d) - Date.parse(prev)) / 86400000) : 0;
      run = gap === 1 ? run + 1 : 1;
      bestStreak = Math.max(bestStreak, run);
      prev = d;
    }
    const todayKey = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
    const yesterdayKey = new Date(now + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
    let streak = 0;
    for (let i = 0; i < 400; i++) {
      const key = new Date(now + 8 * 3600000 - i * 86400000).toISOString().slice(0, 10);
      if (dailyMap.get(key)) streak++;
      else if (key !== todayKey && key !== yesterdayKey) break;
      else if (key === todayKey || key === yesterdayKey) continue;
    }
    if (user.stats && typeof user.stats.streakDays === 'number') streak = Math.max(streak, user.stats.streakDays);

    ctx.http.send(res, 200, {
      ok: true,
      totalSubmissions: subs.length,
      totalSolved: solvedSet.size,
      heatmap: Object.fromEntries(dailyMap),
      mastery,
      recommended,
      streak,
      subject: subject,
      bestStreak: Math.max(bestStreak, streak)
    });
  });

  for (const p of ['/api/my/stats']) router.all(p, handle);
  return handle;
};
