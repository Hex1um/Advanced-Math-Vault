/**
 * 期末突击路由组（v1.6.0，v2.0.0 架构下重写）
 *
 *   GET  /api/sprint/packs                      科目列表（公开）
 *   GET  /api/sprint/packs/:id                  章节与知识点骨架（公开）
 *   GET  /api/sprint/packs/:id/points/:pid      知识点详情（公开）
 *   POST /api/sprint/packs/:id/similar          找类似题：包内真题优先，不够再 AI 出
 *   POST /api/sprint/packs/:id/explain          AI 讲解（无可用模型时退回教材精讲）
 *   POST /api/sprint/packs/:id/answer           判分并记录（客观题自动，主观题给得分点）
 *   POST /api/sprint/packs/:id/reveal           看答案（记一次 reveal，进薄弱权重）
 *   GET  /api/sprint/packs/:id/weak             薄弱分析
 *   POST /api/sprint/packs/:id/plan             改善方案（规则版 / AI 版）
 *
 * 与 v2.0.0 的其他路由模块一致：签名 (router, ctx)，路由体保留 pathname + method 分支，
 * 便于按域审查。科目包对象由 server.js 创建后挂在 ctx.sprint 上。
 */
'use strict';

module.exports = function registerSprintRoutes(router, ctx) {
  const { send, fail, readBody } = ctx.http;
  const { saveDb, callLLM, llmCandidates, rateLimit } = ctx.services;
  const spr = ctx.sprint;

  const AI_MAX = 40;
  const AI_WINDOW = 10 * 60 * 1000;

  function aiLimited(user) {
    return !rateLimit('sprint-ai:' + user.id, AI_MAX, AI_WINDOW);
  }

  function progressOf(db, user, packId) {
    if (!user) return spr.blankProgress();
    db.sprint = db.sprint || {};
    const mine = db.sprint[user.id] || (db.sprint[user.id] = {});
    return spr.normalizeProgress(mine[packId]);
  }

  function saveProgress(db, user, packId, prog) {
    if (!user) return;
    db.sprint = db.sprint || {};
    const mine = db.sprint[user.id] || (db.sprint[user.id] = {});
    mine[packId] = prog;
    saveDb();
  }

  /** 依次尝试可用通道；全挂返回 null，由调用方决定降级文案 */
  async function tryLLM(llmBody, messages) {
    for (const cfg of llmCandidates(llmBody || null)) {
      try {
        const text = await callLLM(cfg, messages);
        if (text && String(text).trim()) return { text: String(text), cfg: cfg };
      } catch (e) { /* 降级到下一档 */ }
    }
    return null;
  }

  function localExplain(pack, p) {
    const ch = pack.chapterById.get(p.chapter) || {};
    const lines = ['### 一句话结论', p.core];
    if (p.detail) lines.push('', '### 展开', p.detail);
    if (p.keys.length) lines.push('', '### 关键词', p.keys.map((k) => '`' + k + '`').join(' '));
    if (p.examTypes.length) {
      lines.push('', '### 怎么考', p.examTypes.map((t) => '· ' + (spr.TYPE_NAME[t] || t)).join('\n'));
    }
    if (p.traps.length) lines.push('', '### 易错提醒', p.traps.map((t) => '· ' + t).join('\n'));
    if (ch.title) lines.push('', '> 章节：' + (ch.no ? ch.no + ' ' : '') + ch.title);
    lines.push('', '> 当前没有可用的 AI 通道，以上是科目包预置的精讲。配置站点模型或自己的 Key 后可以追问。');
    return lines.join('\n');
  }

  async function handle(rc) {
    const { req, res, pathname, user } = rc;
    const method = req.method;
    const db = ctx.db;

    /* ---------------------------------------------------- 科目列表 */
    if (pathname === '/api/sprint/packs' && method === 'GET') {
      const mine = {};
      if (user) {
        const all = (db.sprint && db.sprint[user.id]) || {};
        for (const k of Object.keys(all)) {
          const p = spr.normalizeProgress(all[k]);
          mine[k] = {
            attempts: p.attempts.length,
            points: Object.keys(p.stats).length,
            planAt: p.planAt,
            lastAt: p.attempts.length ? p.attempts[p.attempts.length - 1].at : 0
          };
        }
      }
      return send(res, 200, { ok: true, packs: spr.list(), mine: mine });
    }

    const m = pathname.match(/^\/api\/sprint\/packs\/([A-Za-z0-9_-]+)(?:\/(points|similar|explain|answer|reveal|weak|plan)(?:\/([A-Za-z0-9_-]+))?)?$/);
    if (!m) return fail(res, 404, '接口不存在');
    const pack = spr.get(m[1]);
    if (!pack) return fail(res, 404, '科目包不存在');
    const action = m[2] || '';
    const subId = m[3] || '';

    /* ---------------------------------------------------- 科目骨架 */
    if (!action && method === 'GET') {
      const prog = progressOf(db, user, pack.id);
      return send(res, 200, {
        ok: true,
        pack: {
          id: pack.id,
          school: pack.school,
          schoolShort: pack.schoolShort,
          subject: pack.subject,
          subjectShort: pack.subjectShort,
          year: pack.year,
          term: pack.term,
          intro: pack.intro,
          updatedAt: pack.updatedAt,
          exam: pack.exam,
          sources: pack.sources,
          counts: pack.counts
        },
        chapters: spr.outline(pack),
        me: user ? {
          attempts: prog.attempts.length,
          touchedPoints: Object.keys(prog.stats).length,
          asks: prog.asks.length,
          planAt: prog.planAt
        } : null
      });
    }

    /* ---------------------------------------------------- 知识点详情 */
    if (action === 'points' && method === 'GET') {
      const d = spr.pointDetail(pack, subId);
      if (!d) return fail(res, 404, '知识点不存在');
      const prog = progressOf(db, user, pack.id);
      const s = prog.stats[d.id] || {};
      return send(res, 200, {
        ok: true,
        point: d,
        mine: {
          attempts: Number(s.n) || 0,
          correct: Number(s.ok) || 0,
          asks: Number(s.asks) || 0,
          reveals: Number(s.reveals) || 0
        }
      });
    }

    /* ---------------------------------------------------- 找类似题 */
    if (action === 'similar' && method === 'POST') {
      const body = await readBody(req);
      const pid = String(body.pointId || subId || '').trim();
      const p = pack.pointById.get(pid);
      if (!p) return fail(res, 404, '知识点不存在');
      const found = spr.similar(pack, {
        pointId: pid,
        limit: Number(body.limit) || 5,
        exclude: Array.isArray(body.exclude) ? body.exclude : []
      });
      const items = found.items.map((q) => spr.publicQuestion(q, { reveal: false }));

      let generated = [];
      let note = '';
      if (body.generate && found.remaining > 0) {
        if (!user) return fail(res, 401, '登录后才能让 AI 出题');
        if (aiLimited(user)) return fail(res, 429, 'AI 调用太频繁，等几分钟再试');
        const hit = await tryLLM(body.llm, spr.generateMessages(pack, p, {
          count: found.remaining, type: body.type
        }));
        if (hit) {
          generated = spr.parseGeneratedQuestions(hit.text, pack, p)
            .map((q) => spr.publicQuestion(q, { reveal: false }));
          note = 'AI 补题 ' + generated.length + ' 道（未审核，做完请对照解析）';
        } else {
          note = '当前没有可用的 AI 通道，先用包内题目刷一遍';
        }
      }
      return send(res, 200, {
        ok: true,
        items: items.concat(generated),
        pool: found.pool,
        remaining: found.remaining,
        note: note
      });
    }

    /* ---------------------------------------------------- AI 讲解 */
    if (action === 'explain' && method === 'POST') {
      if (!user) return fail(res, 401, '登录后才能提问');
      const body = await readBody(req);
      const pid = String(body.pointId || subId || '').trim();
      const p = pack.pointById.get(pid);
      if (!p) return fail(res, 404, '知识点不存在');
      if (aiLimited(user)) return fail(res, 429, 'AI 调用太频繁，等几分钟再试');
      const question = String(body.question || '').slice(0, 600);
      const hit = await tryLLM(body.llm, spr.explainMessages(pack, p, { question: question, mode: body.mode }));
      if (question) {
        const prog = progressOf(db, user, pack.id);
        spr.recordAsk(prog, pid, question);
        saveProgress(db, user, pack.id, prog);
      }
      return send(res, 200, hit
        ? { ok: true, text: hit.text, mode: hit.cfg.mode, model: hit.cfg.model }
        : { ok: true, text: localExplain(pack, p), mode: 'local', model: '' });
    }

    /* ---------------------------------------------------- 判分 */
    if (action === 'answer' && method === 'POST') {
      if (!user) return fail(res, 401, '先登录，答题记录才会保存');
      const body = await readBody(req);
      const q = pack.questionById.get(String(body.questionId || '').trim());
      if (!q) return fail(res, 404, '题目不存在');

      const result = spr.grade(q, body.answer);
      if (result.needsHuman) {
        let ai = null;
        if (body.aiGrade) {
          if (aiLimited(user)) return fail(res, 429, 'AI 调用太频繁，等几分钟再试');
          const hit = await tryLLM(body.llm, spr.gradeSubjectiveMessages(pack, q, body.answer));
          if (hit) ai = hit.text;
        }
        return send(res, 200, {
          ok: true,
          needsHuman: true,
          answer: q.answer,
          explain: q.explain,
          ai: ai,
          judge: ai ? 'ai' : 'self'
        });
      }

      const prog = progressOf(db, user, pack.id);
      spr.recordAnswer(prog, q, result, Date.now());
      saveProgress(db, user, pack.id, prog);
      return send(res, 200, {
        ok: true,
        correct: !!result.correct,
        expected: result.expected,
        got: result.got,
        answer: q.answer,
        explain: q.explain,
        points: q.points
      });
    }

    /* ---------------------------------------------------- 看答案 */
    if (action === 'reveal' && method === 'POST') {
      const body = await readBody(req);
      const q = pack.questionById.get(String(body.questionId || '').trim());
      if (!q) return fail(res, 404, '题目不存在');
      if (user) {
        const prog = progressOf(db, user, pack.id);
        spr.recordReveal(prog, q, Date.now());
        saveProgress(db, user, pack.id, prog);
      }
      return send(res, 200, { ok: true, answer: q.answer, explain: q.explain, source: q.source });
    }

    /* ---------------------------------------------------- 薄弱分析 */
    if (action === 'weak' && method === 'GET') {
      const prog = progressOf(db, user, pack.id);
      return send(res, 200, { ok: true, weak: spr.weakness(pack, prog), login: !!user });
    }

    /* ---------------------------------------------------- 改善方案 */
    if (action === 'plan' && method === 'POST') {
      if (!user) return fail(res, 401, '先登录，方案才会按你的记录生成');
      const body = await readBody(req);
      if (aiLimited(user)) return fail(res, 429, 'AI 调用太频繁，等几分钟再试');
      const prog = progressOf(db, user, pack.id);
      const weak = spr.weakness(pack, prog);
      let text = '';
      let mode = 'rule';
      if (body.ai !== false) {
        const hit = await tryLLM(body.llm, spr.planMessages(pack, weak, { days: body.days }));
        if (hit) { text = hit.text; mode = 'ai'; }
      }
      let plan = null;
      if (!text) {
        plan = spr.buildPlan(pack, weak);
        text = '## ' + plan.title + '\n\n' + plan.lines.map((l) => '- ' + l).join('\n');
      }
      prog.plan = text;
      prog.planAt = Date.now();
      saveProgress(db, user, pack.id, prog);
      return send(res, 200, { ok: true, text: text, mode: mode, plan: plan, weak: weak });
    }

    return fail(res, 404, '接口不存在');
  }

  router.all('/api/sprint', handle);
  router.all('/api/sprint/*', handle);
  return handle;
};
