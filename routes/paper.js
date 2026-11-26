/**
 * 组卷与模考域路由组（v2.0.0 拆分）
 *
 * 智能组卷、固定题型组卷、客观题自动判分。
 *
 * 签名统一为 (router, ctx)：router 负责路径匹配与中间件，ctx 提供 db / services / http。
 * 路由体沿用 server.js 时代的分支写法（pathname + method 判定），
 * 这样拆分本身不改变任何一条接口的行为，便于逐域审查与回归。
 */
'use strict';

module.exports = function registerPaperRoutes(router, ctx) {
  const { send, fail, readBody, clientIp, parseCookies, isHttps } = ctx.http;
  const {
    tagTax,
    levelOf,
    problemKind,
    examPoints,
    answersEquiv,
    processMatchesAnswer
  } = ctx.services;

  async function handle(rc) {
    const { req, res, pathname, query, user } = rc;
    const method = req.method;
    const db = ctx.db;
  /* ---- 组卷：按考研题型结构随机抽题 ---- */
  /* ---- 智能组卷：按考点覆盖 + 难度配额抽题，附建议时长与分值 ---- */
  if (pathname === '/api/paper/auto' && method === 'POST') {
    const body = await readBody(req);
    const want = Math.max(3, Math.min(30, Number(body.count || 10)));
    const minutes = Math.max(10, Math.min(180, Number(body.minutes || Math.round(want * 5))));
    /* 学科：物理卷只从物理题抽，避免「数学卷里混进一道刚体转动」；
       不传 subject 时按数学，与旧行为一致。 */
    const subject = tagTax.subjectOf(body.subject);
    const allowedMains = tagTax.SUBJECTS[subject].mainTags;
    const mains = Array.isArray(body.mainTags)
      ? body.mainTags.map(String).filter((t) => allowedMains.includes(t))
      : [];
    const diff = ['easy', 'medium', 'hard', 'mixed'].includes(String(body.difficulty))
      ? String(body.difficulty) : 'mixed';

    let pool = db.problems.filter((p) => p.status === 'approved' && tagTax.subjectOf(p.subject) === subject);
    if (mains.length) pool = pool.filter((p) => mains.includes(p.mainTag));
    if (diff === 'easy') pool = pool.filter((p) => p.difficulty <= 4);
    if (diff === 'medium') pool = pool.filter((p) => p.difficulty >= 4 && p.difficulty <= 7);
    if (diff === 'hard') pool = pool.filter((p) => p.difficulty >= 7);
    if (!pool.length) return fail(res, 404, '这个范围里暂时没有可用的题，换个考点或难度再试');

    const kindOf = problemKind;
    const shuffle = (arr) => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    /* 难度配额：混合卷 30/50/20，其他按单一档 */
    const quota = diff === 'mixed'
      ? { easy: Math.round(want * 0.3), medium: Math.round(want * 0.5), hard: 0 }
      : { easy: 0, medium: 0, hard: 0 };
    if (diff === 'mixed') quota.hard = Math.max(0, want - quota.easy - quota.medium);
    else quota[diff] = want;

    const groups = new Map();
    for (const p of shuffle(pool)) {
      const k = p.mainTag || '综合';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    const order = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length);
    const picked = [];
    const pickedSet = new Set();
    const takeFrom = (p, bucket) => {
      if (picked.length >= want) return false;
      if (quota[bucket] <= 0) return false;
      picked.push(p);
      pickedSet.add(p.code);
      quota[bucket] -= 1;
      return true;
    };
    const bucketOf = (p) => (p.difficulty <= 4 ? 'easy' : p.difficulty <= 7 ? 'medium' : 'hard');

    /* 第一轮：按主标签轮转，每个主标签贡献一题，保证覆盖面 */
    let progressed = true;
    while (picked.length < want && progressed) {
      progressed = false;
      for (const k of order) {
        if (picked.length >= want) break;
        const bucket = groups.get(k);
        if (!bucket || !bucket.length) continue;
        const idx = bucket.findIndex((p) => !pickedSet.has(p.code) && quota[bucketOf(p)] > 0);
        if (idx < 0) continue;
        const [p] = bucket.splice(idx, 1);
        if (takeFrom(p, bucketOf(p))) progressed = true;
      }
    }
    /* 第二轮：配额没填满（某个难度档题不够）就用剩下的题补 */
    for (const k of order) {
      for (const p of groups.get(k) || []) {
        if (picked.length >= want) break;
        if (pickedSet.has(p.code)) continue;
        picked.push(p);
        pickedSet.add(p.code);
      }
    }

    const perQuestionSec = Math.max(60, Math.round((minutes * 60) / Math.max(1, picked.length)));
    const partDef = [
      { kind: 'choice', name: '一、选择题' },
      { kind: 'fill', name: '二、填空题' },
      { kind: 'solution', name: '三、解答题' }
    ];
    const parts = partDef.map((def) => {
      const items = picked.filter((p) => kindOf(p) === def.kind);
      return {
        kind: def.kind,
        name: def.name,
        items: items.map((p) => ({
          code: p.code,
          title: p.title,
          statement: p.statement,
          tags: p.tags,
          source: p.source,
          difficulty: p.difficulty,
          thinking: p.thinking,
          calc: p.calc,
          points: examPoints(p),
          seconds: perQuestionSec
        }))
      };
    }).filter((x) => x.items.length);

    const coverage = {};
    for (const p of picked) coverage[p.mainTag || '综合'] = (coverage[p.mainTag || '综合'] || 0) + 1;

    return send(res, 200, {
      ok: true,
      title: '高等数学' + (mains.length === 1 ? mains[0] : '') + '自测卷',
      generatedAt: new Date().toISOString(),
      minutes,
      perQuestionSec,
      total: picked.length,
      totalPoints: picked.reduce((s2, p) => s2 + examPoints(p), 0),
      difficulty: diff,
      coverage,
      parts
    });
  }

  /* ---- 模考判卷：客观题按答案等价判定，解答题只标「待自评」 ---- */
  if (pathname === '/api/exam/grade' && method === 'POST') {
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
    if (!items.length) return fail(res, 400, '没有要判的题');
    const out = [];
    let score = 0;
    let total = 0;
    for (const it of items) {
      const code = String((it && it.code) || '').toUpperCase();
      const p = db.problems.find((x) => x.code === code && x.status === 'approved');
      if (!p) { out.push({ code, status: 'missing', score: 0, points: 0 }); continue; }
      const points = examPoints(p);
      total += points;
      const kind = problemKind(p);
      const given = String((it && it.answer) || '').trim().slice(0, 2000);
      if (kind === 'solution') {
        // 解答题没法用字符串比对判分，标成待自评，让用户回原题走正常判卷
        out.push({ code, status: 'manual', score: 0, points, kind });
        continue;
      }
      if (!given) { out.push({ code, status: 'blank', score: 0, points, kind }); continue; }
      const okAnswer = answersEquiv(given, p.answer) || processMatchesAnswer(given, p.answer);
      if (okAnswer) score += points;
      // 不返回正确答案：答案仍然只在原题的 /reveal 里给（避免匿名批量刷答案）
      out.push({ code, status: okAnswer ? 'correct' : 'wrong', score: okAnswer ? points : 0, points, kind });
    }
    return send(res, 200, {
      ok: true,
      score,
      total,
      percent: total ? Math.round((score / total) * 100) : 0,
      items: out
    });
  }

  if (pathname === '/api/paper/generate' && method === 'POST') {
    const body = await readBody(req);
    const spec = {
      choice: Math.max(0, Math.min(20, Number(body.choice !== undefined ? body.choice : 10))),
      fill: Math.max(0, Math.min(20, Number(body.fill !== undefined ? body.fill : 6))),
      solution: Math.max(0, Math.min(20, Number(body.solution !== undefined ? body.solution : 6))),
      mainTag: String(body.mainTag || '').slice(0, 20),
      tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 5) : [],
      difficulty: String(body.difficulty || '')
    };

    let pool = db.problems.filter((p) => p.status === 'approved');
    if (spec.mainTag) pool = pool.filter((p) => p.mainTag === spec.mainTag);
    if (spec.tags.length) pool = pool.filter((p) => p.tags.some((t) => spec.tags.includes(t)));
    if (spec.difficulty) pool = pool.filter((p) => levelOf(p.difficulty).name === spec.difficulty);

    const isExam = (p) => /^\d{4}\s*数学一/.test(p.title || '');
    const kindOfTitle = (p) => (/选择题/.test(p.title) ? 'choice' : /填空题/.test(p.title) ? 'fill' : 'solution');
    const picked = new Set();
    const pickKind = (kind, n) => {
      let cand = pool.filter((p) => !picked.has(p.code));
      const typed = cand.filter((p) => isExam(p) && kindOfTitle(p) === kind);
      // 优先用考研真题里对应题型的题，不够再用普通题补足
      cand = typed.length >= n ? typed : typed.concat(cand.filter((p) => !isExam(p)));
      for (let i = cand.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cand[i], cand[j]] = [cand[j], cand[i]];
      }
      const out = cand.slice(0, n);
      out.forEach((p) => picked.add(p.code));
      return out;
    };

    const parts = [
      { kind: 'choice', name: '一、选择题', items: pickKind('choice', spec.choice) },
      { kind: 'fill', name: '二、填空题', items: pickKind('fill', spec.fill) },
      { kind: 'solution', name: '三、解答题', items: pickKind('solution', spec.solution) }
    ];

    return send(res, 200, {
      ok: true,
      title: '高等数学自测卷',
      generatedAt: new Date().toISOString(),
      total: parts.reduce((s, x) => s + x.items.length, 0),
      parts: parts.map((x) => ({
        kind: x.kind,
        name: x.name,
        items: x.items.map((p) => ({
          code: p.code, title: p.title, statement: p.statement,
          tags: p.tags, thinking: p.thinking, difficulty: p.difficulty, calc: p.calc, source: p.source
        }))
      }))
    });
  }
  }

  for (const p of ['/api/paper/*', '/api/exam/grade']) router.all(p, handle);
  return handle;
};
