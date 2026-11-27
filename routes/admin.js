/**
 * 管理端路由组（v2.0.0 拆分）
 *
 * 审核、导入导出、AI 通道面板、反馈处理、改分、删号、OCR 坏例。
 *
 * 签名统一为 (router, ctx)：router 负责路径匹配与中间件，ctx 提供 db / services / http。
 * 路由体沿用 server.js 时代的分支写法（pathname + method 判定），
 * 这样拆分本身不改变任何一条接口的行为，便于逐域审查与回归。
 */
'use strict';

module.exports = function registerAdminRoutes(router, ctx) {
  const { send, fail, readBody, clientIp, parseCookies, isHttps, intParam } = ctx.http;
  const {
    store,
    tagTax,
    saveDb,
    configSummary,
    clampScore,
    normalizeProblem,
    cleanPhysicsMeta,
    nextProblemCode,
    xpForProblem,
    todayKey,
    isIntegralProblem,
    logActivity,
    ai,
    llmConfigured,
    safeLlmBaseUrl,
    aiStats,
    publicFeedback
  } = ctx.services;

  async function handle(rc) {
    const { req, res, pathname, query, user } = rc;
    const method = req.method;
    const db = ctx.db;
  /* ---- 管理端 ---- */
/* 管理端删除题目：连带清掉每日一题、用户做题记录、帖子关联，保留历史提交但标记 */
function deleteProblemCascade(code, adminName) {
  const idx = db.problems.findIndex((p) => p.code === code);
  if (idx < 0) return null;
  db.problems.splice(idx, 1);
  let daily = 0;
  if (db.daily && typeof db.daily === 'object') {
    for (const date of Object.keys(db.daily)) {
      if (db.daily[date] === code) { delete db.daily[date]; daily++; }
    }
  }
  let userRecords = 0;
  for (const u of db.users || []) {
    for (const key of ['solved', 'best', 'wrong']) {
      if (u[key] && Object.prototype.hasOwnProperty.call(u[key], code)) { delete u[key][code]; userRecords++; }
    }
  }
  let posts = 0;
  for (const post of db.posts || []) {
    if (post.problemCode === code) { post.problemCode = ''; posts++; }
  }
  for (const sub of db.submissions || []) {
    if (sub.code === code) sub.problemDeleted = true;
  }
  for (const fb of db.feedbacks || []) {
    if (fb.code === code) {
      fb.problemDeleted = true;
      fb.status = 'resolved';
      fb.handledAt = fb.handledAt || new Date().toISOString();
      fb.handlerName = fb.handlerName || adminName;
    }
  }
  return { daily, userRecords, posts };
}

  if (pathname.startsWith('/api/admin/')) {
    if (!user || user.role !== 'admin') return fail(res, 403, '需要管理员权限');

    /* 上线配置体检：管理员能看到「到底哪些环境变量没配对」 */
    if (pathname === '/api/admin/env' && method === 'GET') {
      return send(res, 200, Object.assign({ ok: true }, configSummary()));
    }

    /* AI 通道可用性面板 */
    if (pathname === '/api/admin/ai-stats' && method === 'GET') {
      const st = aiStats();
      const channels = Object.keys(st.channels).map((name) => {
        const b = st.channels[name] || {};
        const total = (b.ok || 0) + (b.fail || 0);
        return {
          name,
          ok: b.ok || 0,
          fail: b.fail || 0,
          calls: total,
          successRate: total ? Math.round(((b.ok || 0) / total) * 100) : 0,
          avgMs: b.ok ? Math.round((b.msSum || 0) / b.ok) : 0,
          lastOkAt: b.lastOkAt || '',
          lastErrorAt: b.lastErrorAt || '',
          lastError: b.lastError || ''
        };
      }).sort((a, b) => b.calls - a.calls);
      return send(res, 200, { ok: true, since: st.since, calls: st.calls || 0, channels });
    }

    const adminProblemMatch = pathname.match(/^\/api\/admin\/problem\/([A-Za-z0-9_-]+)$/);
    if (adminProblemMatch && method === 'GET') {
      const p = db.problems.find((x) => x.code === adminProblemMatch[1]);
      if (!p) return fail(res, 404, '题目不存在');
      return send(res, 200, { ok: true, problem: p });
    }
    if (adminProblemMatch && method === 'POST') {
      const p = db.problems.find((x) => x.code === adminProblemMatch[1]);
      if (!p) return fail(res, 404, '题目不存在');
      const body = await readBody(req);
      if (body.title !== undefined) {
        const title = String(body.title).trim();
        if (title.length < 2) return fail(res, 400, '标题至少 2 个字');
        p.title = title.slice(0, 120);
      }
      if (body.statement !== undefined) {
        const statement = String(body.statement).trim();
        if (statement.length < 8) return fail(res, 400, '题干至少 8 个字');
        p.statement = statement;
      }
      if (body.answer !== undefined) p.answer = String(body.answer).trim();
      if (body.solution !== undefined) {
        const solution = String(body.solution).trim();
        if (!solution) return fail(res, 400, '解析不能为空');
        p.solution = solution;
      }
      if (Array.isArray(body.hints)) p.hints = body.hints.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 5);
      if (body.source !== undefined) p.source = String(body.source).slice(0, 80);
      if (Array.isArray(body.tags) && body.tags.length) {
        const tagInfo = tagTax.normalize(body.tags, p.mainTag, p.subject);
        p.mainTag = tagInfo.mainTag; p.tags = tagInfo.tags;
      }
      /* 审核后台可直接改物理元数据（单位/容差/常数/思想标签）：
         题库里最常需要人工修的就是「单位写错」和「容差过严」。 */
      if (body.physicsMeta && tagTax.subjectOf(p.subject) === 'physics') {
        p.physicsMeta = cleanPhysicsMeta(Object.assign({}, p.physicsMeta, body.physicsMeta), p);
      }
      if (body.thinking !== undefined) p.thinking = clampScore(body.thinking, p.thinking);
      if (body.difficulty !== undefined) p.difficulty = clampScore(body.difficulty, p.difficulty);
      if (body.calc !== undefined) p.calc = clampScore(body.calc, p.calc);
      p.editedAt = new Date().toISOString();
      p.editorName = user.name;
      if (body.feedbackId) {
        const fb = db.feedbacks.find((f) => f.id === Number(body.feedbackId));
        if (fb) {
          fb.status = 'resolved'; fb.handledAt = p.editedAt; fb.handlerName = user.name;
          fb.adminNote = String(body.note || '已修改题目/解析').slice(0, 500);
        }
      }
      saveDb();
      return send(res, 200, { ok: true, code: p.code });
    }
    const adminDeleteMatch = pathname.match(/^\/api\/admin\/problem\/([A-Za-z0-9_-]+)\/delete$/);
    if (adminDeleteMatch && method === 'POST') {
      const code = adminDeleteMatch[1];
      const body = await readBody(req);
      const result = deleteProblemCascade(code, user.name);
      if (!result) return fail(res, 404, '题目不存在');
      if (body.feedbackId) {
        const fb = db.feedbacks.find((f) => f.id === Number(body.feedbackId));
        if (fb) {
          fb.status = 'resolved'; fb.problemDeleted = true;
          fb.handledAt = new Date().toISOString(); fb.handlerName = user.name;
          fb.adminNote = String(body.note || '题目已删除').slice(0, 500);
        }
      }
      saveDb();
      return send(res, 200, { ok: true, code, removed: result });
    }

    if (pathname === '/api/admin/pending' && method === 'GET') {
      const subjectQ = String(query.subject || '').toLowerCase();
      const items = db.problems.filter((p) => p.status === 'pending'
        && (!subjectQ || tagTax.subjectOf(p.subject) === tagTax.subjectOf(subjectQ))).map((p) => ({
        code: p.code, subject: tagTax.subjectOf(p.subject), title: p.title, statement: p.statement,
        mainTag: p.mainTag, tags: p.tags, examTags: p.examTags || [], kind: p.kind,
        physicsMeta: p.physicsMeta || null,
        thinking: p.thinking, difficulty: p.difficulty, calc: p.calc,
        source: p.source, authorName: p.authorName, createdAt: p.createdAt,
        hints: p.hints, answer: p.answer, solution: p.solution
      }));
      return send(res, 200, { ok: true, items });
    }

    if (pathname === '/api/admin/review' && method === 'POST') {
      const body = await readBody(req);
      const p = db.problems.find((x) => x.code === String(body.code || '').toUpperCase());
      if (!p) return fail(res, 404, '题目不存在');
      const action = String(body.action || '');
      if (action === 'approve') {
        const patch = body.patch || {};
        if (patch.title) p.title = String(patch.title).slice(0, 120);
        if (patch.statement) p.statement = String(patch.statement);
        if (patch.mainTag !== undefined && tagTax.isValidMain(patch.mainTag)) p.mainTag = String(patch.mainTag);
        if (Array.isArray(patch.tags) && patch.tags.length) {
          const tagInfo = tagTax.normalize(patch.tags, p.mainTag);
          p.mainTag = tagInfo.mainTag;
          p.tags = tagInfo.tags;
          if (tagInfo.kind) p.kind = tagInfo.kind;
        }
        if (patch.thinking !== undefined) p.thinking = clampScore(patch.thinking, p.thinking);
        if (patch.difficulty !== undefined) p.difficulty = clampScore(patch.difficulty, p.difficulty);
        if (patch.calc !== undefined) p.calc = clampScore(patch.calc, p.calc);
        if (patch.source !== undefined) p.source = String(patch.source).slice(0, 80);
        if (Array.isArray(patch.hints)) p.hints = patch.hints.map(String).slice(0, 5);
        if (patch.answer !== undefined) p.answer = String(patch.answer);
        if (patch.solution !== undefined) p.solution = String(patch.solution);
        p.status = 'approved';
        p.reviewedAt = new Date().toISOString();
        p.reviewerName = user.name;
        p.rejectReason = '';
        const author = db.users.find((u) => u.id === p.authorId);
        if (author) { author.exp = (author.exp || 0) + 30; logActivity(author, '投稿 ' + p.code + ' 通过审核，+30 经验', p.code); }
      } else if (action === 'reject') {
        p.status = 'rejected';
        p.rejectReason = String(body.reason || '未说明原因').slice(0, 200);
        p.reviewedAt = new Date().toISOString();
      } else if (action === 'delete') {
        deleteProblemCascade(p.code, user.name);
      } else {
        return fail(res, 400, '未知操作');
      }
      saveDb();
      return send(res, 200, { ok: true });
    }

    if (pathname === '/api/admin/import' && method === 'POST') {
      const body = await readBody(req, 4 * 1024 * 1024);
      const list = Array.isArray(body.problems) ? body.problems : (Array.isArray(body) ? body : null);
      if (!list) return fail(res, 400, '需要 problems 数组');
      const added = [];
      const skipped = [];
      for (const raw of list) {
        const item = normalizeProblem(raw);
        if (!item) { skipped.push(String(raw && raw.title || '无标题')); continue; }
        item.code = nextProblemCode(item.subject);
        item.status = 'approved';
        item.authorName = (raw && raw.authorName) || user.name;
        item.authorId = user.id;
        item.reviewedAt = new Date().toISOString();
        db.problems.push(item);
        // 带上门禁结果，导入方能立刻看到哪些题需要人工复核
        added.push({ code: item.code, title: item.title, qualityWarn: item.qualityWarn || [] });
      }
      saveDb();
      return send(res, 200, { ok: true, added, addedCodes: added.map((a) => a.code), skipped });
    }

    if (pathname === '/api/admin/submissions' && method === 'GET') {
      const limit = intParam(query.limit, 60, 1, 200);
      const items = db.submissions.slice(-limit).reverse().map((x) => {
        const pr = db.problems.find((pp) => pp.code === x.code);
        return Object.assign({}, x, {
          title: pr ? pr.title : '',
          difficulty: pr ? pr.difficulty : null
        });
      });
      return send(res, 200, { ok: true, total: db.submissions.length, items });
    }

    if (pathname === '/api/admin/export' && method === 'GET') {
      const payload = {
        exportedAt: new Date().toISOString(),
        problems: db.problems,
        posts: db.posts,
        daily: db.daily,
        feedbacks: db.feedbacks,
        submissions: db.submissions || []
      };
      // 带上用户（含密码哈希）：只给管理员，用于部署前把线上账号/经验合并回本地，避免覆盖
      if (/[?&]withUsers=1/.test(req.url || '')) payload.users = db.users;
      const body = JSON.stringify(payload, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="math-vault-backup-' + todayKey() + '.json"',
        'Cache-Control': 'no-store'
      });
      return res.end(body);
    }

    if (pathname === '/api/admin/llm' && method === 'GET') {
      return send(res, 200, {
        ok: true,
        llm: {
          baseUrl: db.settings.llm.baseUrl,
          model: db.settings.llm.model,
          configured: llmConfigured(),
          keyHint: db.settings.llm.apiKey ? db.settings.llm.apiKey.slice(0, 4) + '••••' + db.settings.llm.apiKey.slice(-4) : ''
        },
        // 站点级识图配置：给全站用户读图用；只回脱敏 key，绝不回明文
        vision: {
          baseUrl: (db.settings.llmVision || {}).baseUrl || '',
          model: (db.settings.llmVision || {}).model || '',
          configured: !!(db.settings.llmVision && db.settings.llmVision.apiKey),
          keyHint: db.settings.llmVision && db.settings.llmVision.apiKey
            ? db.settings.llmVision.apiKey.slice(0, 4) + '••••' + db.settings.llmVision.apiKey.slice(-4)
            : ''
        }
      });
    }

    if (pathname === '/api/admin/llm' && method === 'POST') {
      const body = await readBody(req);
      // 两组配置严格分流：target='vision' 只碰 llmVision，绝不写解题模型；
      // 反之只碰 llm。前端识图卡片提交的是顶层 baseUrl/model/apiKey+target，
      // 若不分流就会把解题模型覆盖成识图模型。
      const isVision = body.target === 'vision' || body.vision;
      if (isVision) {
        const v = body.vision || body;
        db.settings.llmVision = db.settings.llmVision || {};
        if (v.baseUrl !== undefined) {
          const nb = safeLlmBaseUrl(v.baseUrl);
          if (!nb) return fail(res, 400, '识图接口地址不合法或不在白名单内');
          db.settings.llmVision.baseUrl = nb;
        }
        if (v.model !== undefined) db.settings.llmVision.model = String(v.model).trim();
        if (v.apiKey !== undefined && String(v.apiKey).trim()) db.settings.llmVision.apiKey = String(v.apiKey).trim();
        if (body.clearKey) db.settings.llmVision.apiKey = '';
      } else {
        if (body.baseUrl !== undefined) {
          const normalized = safeLlmBaseUrl(body.baseUrl);
          if (!normalized) return fail(res, 400, '接口地址必须是 https，且域名在白名单内（可用 LLM_ALLOWED_HOSTS 扩展）');
          db.settings.llm.baseUrl = normalized;
        }
        if (body.model !== undefined) db.settings.llm.model = String(body.model).trim();
        if (body.apiKey !== undefined && String(body.apiKey).trim()) db.settings.llm.apiKey = String(body.apiKey).trim();
        if (body.clearKey) db.settings.llm.apiKey = '';
      }
      saveDb(true);
      return send(res, 200, {
        ok: true,
        configured: llmConfigured(),
        visionConfigured: !!(db.settings.llmVision && db.settings.llmVision.apiKey),
        visionModel: (db.settings.llmVision && db.settings.llmVision.model) || ''
      });
    }

    if (pathname === '/api/admin/rejected' && method === 'GET') {
      return send(res, 200, {
        ok: true,
        items: db.problems.filter((p) => p.status === 'rejected').map((p) => ({ code: p.code, title: p.title, rejectReason: p.rejectReason }))
      });
    }

    /* 删除账号（清理测试号/恶意注册）。只允许管理员，且不能删自己 */
    /* 每日一积：指定某天的题，或取消指定 */
    if (pathname === '/api/admin/daily' && method === 'POST') {
      const body = await readBody(req);
      const date = String(body.date || todayKey()).slice(0, 10);
      if (body.clear) {
        if (db.dailyOverride) delete db.dailyOverride[date];
        if (db.daily) delete db.daily[date];
        saveDb(true);
        return send(res, 200, { ok: true, cleared: date });
      }
      const code = String(body.code || '').trim();
      if (!code) return fail(res, 400, '缺少题号');
      const p = db.problems.find((x) => x.code === code);
      if (!p) return fail(res, 404, '没有这道题');
      db.dailyOverride = db.dailyOverride || {};
      db.dailyOverride[date] = code;
      db.daily = db.daily || {};
      db.daily[date] = code;
      saveDb(true);
      return send(res, 200, { ok: true, date, code, title: p.title });
    }

    if (pathname === '/api/admin/daily/pool' && method === 'GET') {
      const pool = db.problems.filter((p) => p.status === 'approved' && isIntegralProblem(p));
      const items = pool.slice(0, 300).map((p) => ({ code: p.code, title: p.title, difficulty: p.difficulty, tags: p.tags }));
      return send(res, 200, { ok: true, total: pool.length, items });
    }

    /* 人工改分：申诉复核后调整某次提交的分数 */
    if (pathname === '/api/admin/submissions/override' && method === 'POST') {
      const body = await readBody(req);
      const sid = String(body.submissionId || '').trim();
      const score = Math.max(0, Math.min(100, Math.round(Number(body.score))));
      const note = String(body.comment || '').slice(0, 300);
      const sub = (db.submissions || []).find((x) => x.id === sid);
      if (!sub) return fail(res, 404, '找不到这条提交记录');
      if (!Number.isFinite(score)) return fail(res, 400, '分数要是 0-100 的数字');
      const before = sub.score || 0;
      sub.score = score;
      sub.verdict = score >= 80 ? 'correct' : (score >= 40 ? 'partial' : 'wrong');
      sub.overridden = { by: user.name, at: new Date().toISOString(), comment: note, before };
      const target = db.users.find((u) => u.id === sub.uid);
      const pr = db.problems.find((x) => x.code === sub.code);
      if (target && pr) {
        target.solved = target.solved || {};
        target.wrong = target.wrong || {};
        target.best = target.best || {};
        const curBest = target.best[sub.code];
        if (!curBest || score > curBest.score) target.best[sub.code] = { score, at: sub.at };
        if (score >= 80) {
          if (!(target.solved[sub.code] && target.solved[sub.code].done)) {
            const gained = xpForProblem(pr, target.solved[sub.code]);
            target.solved[sub.code] = Object.assign({}, target.solved[sub.code], {
              at: (target.solved[sub.code] && target.solved[sub.code].at) || Date.now(),
              done: true, score
            });
            target.exp = (target.exp || 0) + gained;
            pr.solvedCount = (pr.solvedCount || 0) + 1;
            logActivity(target, '申诉复核通过 ' + sub.code + '（' + score + ' 分），+' + gained + ' 经验', sub.code);
          } else {
            target.solved[sub.code].score = Math.max(target.solved[sub.code].score || 0, score);
          }
          delete target.wrong[sub.code];
        } else if (!(target.solved[sub.code] && target.solved[sub.code].done)) {
          target.wrong[sub.code] = Object.assign({}, target.wrong[sub.code], {
            at: new Date().toISOString(), score,
            tries: ((target.wrong[sub.code] && target.wrong[sub.code].tries) || 0) + 1,
            intervalDays: 1, lastResult: 'fail', lastReviewAt: Date.now(),
            nextReviewAt: Date.now() + 864e5
          });
        }
      }
      // 关联的申诉标记为已处理
      for (const f of db.feedbacks || []) {
        if (f.submissionId === sid && f.status === 'open') {
          f.status = 'handled';
          f.handledAt = new Date().toISOString();
          f.handlerName = user.name;
          f.adminNote = (f.adminNote ? f.adminNote + ' | ' : '') + '改分为 ' + score + (note ? '：' + note : '');
        }
      }
      saveDb(true);
      return send(res, 200, { ok: true, score, before, verdict: sub.verdict });
    }

    if (pathname === '/api/admin/users/delete' && method === 'POST') {
      const body = await readBody(req);
      const names = (Array.isArray(body.names) ? body.names : [body.name]).map(String).filter(Boolean);
      if (!names.length) return fail(res, 400, '没有指定要删的账号');
      if (names.includes(user.name)) return fail(res, 400, '不能删除自己');
      const victims = db.users.filter((u) => names.includes(u.name));
      if (!victims.length) return fail(res, 404, '没有找到这些账号');
      const ids = new Set(victims.map((u) => u.id));
      db.users = db.users.filter((u) => !ids.has(u.id));
      db.posts = (db.posts || []).filter((p) => !ids.has(p.authorId));
      db.feedbacks = (db.feedbacks || []).filter((f) => !ids.has(f.userId || f.authorId));
      // 连带清理所有含用户身份/理由/邮箱的残留记录（公开后这些是隐私面）
      db.submissions = (db.submissions || []).filter((s) => !ids.has(s.userId || s.uid || s.authorId));
      db.ocrBadcases = (db.ocrBadcases || []).filter((b) => !ids.has(b.uid || b.userId));
      for (const k of Object.keys(db.emailCodes || {})) {
        if (ids.has(k)) delete db.emailCodes[k];
      }
      for (const k of Object.keys(db.sessions || {})) {
        if (db.sessions[k] && ids.has(db.sessions[k].uid || db.sessions[k].userId)) delete db.sessions[k];
      }
      saveDb(true);
      return send(res, 200, { ok: true, removed: victims.map((u) => u.name) });
    }

    /* 题目反馈：只把 AI 审阅过的转给管理员；未审阅的单独计数 */
    if (pathname === '/api/admin/feedbacks' && method === 'GET') {
      const status = String(query.status || 'all');
      let list = db.feedbacks.slice();
      if (status !== 'all') list = list.filter((f) => (f.status || 'open') === status);
      list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      // 判分申诉不走 AI 审阅，直接进管理员待办
      const reviewed = list.filter((f) => (f.ai && f.ai.reviewedAt) || f.type === 'appeal');
      const pending = list.filter((f) => !((f.ai && f.ai.reviewedAt) || f.type === 'appeal'));
      const withTitle = (f) => {
        const pr = db.problems.find((p) => p.code === f.code);
        return Object.assign(publicFeedback(f, user), {
          title: pr ? pr.title : '', tags: pr ? pr.tags : [],
          adminNote: f.adminNote || '', handledAt: f.handledAt || '', handlerName: f.handlerName || ''
        });
      };
      return send(res, 200, {
        ok: true,
        items: reviewed.map(withTitle),
        pending: pending.map(withTitle),
        stats: {
          total: db.feedbacks.length,
          open: db.feedbacks.filter((f) => (f.status || 'open') === 'open').length,
          reviewing: pending.length
        }
      });
    }

    const fbMatch = pathname.match(/^\/api\/admin\/feedback\/(\d+)$/);
    if (fbMatch && method === 'POST') {
      const fb = db.feedbacks.find((f) => f.id === Number(fbMatch[1]));
      if (!fb) return fail(res, 404, '反馈不存在');
      const body = await readBody(req);
      const action = String(body.action || '');
      if (action === 'resolve' || action === 'ignore') {
        fb.status = action === 'resolve' ? 'resolved' : 'ignored';
        fb.adminNote = String(body.note || '').slice(0, 500);
        fb.handledAt = new Date().toISOString();
        fb.handlerName = user.name;
      } else if (action === 'reopen') {
        fb.status = 'open'; fb.adminNote = ''; fb.handledAt = null; fb.handlerName = '';
      } else {
        return fail(res, 400, '未知操作');
      }
      saveDb();
      return send(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/admin/ocr-badcases' && method === 'GET') {
    if (!user || user.role !== 'admin') return fail(res, 403, '需要管理员权限');
    const list = (db.ocrBadcases || []).slice(-200).reverse();
    return send(res, 200, { ok: true, total: (db.ocrBadcases || []).length, items: list });
  }
  }

  for (const p of ['/api/admin/*']) router.all(p, handle);
  return handle;
};
