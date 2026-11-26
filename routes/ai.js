/**
 * AI 能力域路由组（v2.0.0 拆分）
 *
 * 出题、批改提示词、对话 SSE、识图、OCR 规范化与坏例采集。
 *
 * 签名统一为 (router, ctx)：router 负责路径匹配与中间件，ctx 提供 db / services / http。
 * 路由体沿用 server.js 时代的分支写法（pathname + method 判定），
 * 这样拆分本身不改变任何一条接口的行为，便于逐域审查与回归。
 */
'use strict';

module.exports = function registerAiRoutes(router, ctx) {
  const { send, fail, readBody, clientIp, parseCookies, isHttps } = ctx.http;
  const {
    store,
    saveDb,
    VISION_MODEL,
    clampScore,
    localTutorText,
    ai,
    OCR_PROMPT,
    llmMessages,
    buildGenerateMessages,
    normalizeSectionMarks,
    parseTaggedInline,
    parseGenerated,
    extractJson,
    validateGenerated,
    validateFromImage,
    metaSystem,
    parseMetaText,
    completeProblemMeta,
    userLlmConfig,
    llmCandidates,
    callLLM,
    streamLLM
  } = ctx.services;

  async function handle(rc) {
    const { req, res, pathname, query, user } = rc;
    const method = req.method;
    const db = ctx.db;
  /* ---- AI 补全帖子标题 ---- */
  /* 投稿：题干 → AI 补全整条记录（标题/考点/三维评分/提示/答案/解析） */
  if ((pathname === '/api/ai/suggest-meta' || pathname === '/api/ai/complete-problem') && method === 'POST') {
    if (!user) return fail(res, 401, '请先登录');
    const body = await readBody(req);
    const st = String(body.statement || '').trim();
    if (st.length < 8) return fail(res, 400, '题干太短，先识别或写几行再补全');
    const full = pathname === '/api/ai/complete-problem';
    const sys = metaSystem(full);
    const userMsg = { role: 'user', content: '题干：\n' + st.slice(0, 1800) };
    for (const cfg of llmCandidates(body.llm || null)) {
      try {
        const raw = String(await callLLM(cfg, [sys, userMsg]) || '');
        const out = parseMetaText(raw, full);
        if (out.title || out.tags.length || out.hints.length) {
          return send(res, 200, Object.assign({ ok: true, by: cfg.name }, out));
        }
      } catch (e) { /* 换下一个通道 */ }
    }
    return fail(res, 502, '暂时连不上模型，可以手动填');
  }

  /* ---- 对话系统提示词（给浏览器直连免费通道用） ---- */
  if (pathname === '/api/ai/prompt/chat' && method === 'POST') {
    if (!user) return fail(res, 401, '登录后才能使用 AI 接口');
    const body = await readBody(req, 64 * 1024);
    const problem = body.problemCode ? db.problems.find((p) => p.code === String(body.problemCode).toUpperCase()) : null;
    const msgs = llmMessages(problem, [], { expert: body.expert !== false });
    return send(res, 200, { ok: true, system: msgs[0].content });
  }

  /* ---- 识图：给别人用的固定提示词 ---- */
  if (pathname === '/api/ai/ocr-prompt' && method === 'GET') {
    if (!user) return fail(res, 401, '登录后才能使用 AI 接口');
    return send(res, 200, { ok: true, prompt: OCR_PROMPT });
  }

  /* ---- OCR 后处理：把 OCR 认出来的乱串规范成合法 LaTeX ----
     传统 OCR（tesseract 之类）只认字形、不懂二维公式结构，`\frac` 会变成
     `a/b` 或干脆散架。这一步让 AI 结合上下文补回结构，是准确率的关键。 */
  if (pathname === '/api/ai/ocr-fix' && method === 'POST') {
    if (!user) return fail(res, 401, '登录后才能使用 AI 接口');
    const body = await readBody(req, 256 * 1024);
    const raw = String(body.text || '').trim();
    if (!raw) return fail(res, 400, '没有可规范化的文本');
    if (raw.length > 4000) return fail(res, 400, '文本太长，请分段识别');

    const sys = {
      role: 'system',
      content: [
        '你是数学公式转写器。用户给你一段 OCR 识别出来的数学内容，字形可能错，结构可能散。',
        '任务：还原成正确、可编译的 LaTeX。',
        '',
        '规则：',
        '1. 只修正识别错误与公式结构，不要改题目意思、不要补充题目没出现的内容；',
        '2. 分式写成 $\\frac{}{}$，根式 $\\sqrt{}$，上下标用 ^{} _{}，积分 $\\int_{a}^{b}$，极限 $\\lim_{x\\to 0}$；',
        '3. 中文说明保持中文，数学部分用 $...$ 包住；',
        '4. 文本里被 [low]...[/low] 包住的是**低置信度片段**：优先保留原形或写 $\\square$ 占位，绝对不要凭上下文人造数字；',
        '5. 没被标记的部分可信度高，按规则正常还原即可；',
        '6. 直接输出转写结果，不要解释、不要代码块、不要「以下是」。',
        '',
        '常见 OCR 误识别（照这些例子改）：',
        '  「rn」→ m；「I n」/「1n」→ \\ln；「s i n」→ \\sin；「c o s」→ \\cos；',
        '  「l i m」→ \\lim；「x 2」→ x^{2}；「1/2」→ \\frac{1}{2}；「S」在积分语境→ \\int；',
        '  「oo」在极限语境→ \\infty；「->」→ \\to；「<=」→ \\le；「!」在级数语境→ 阶乘。',
        '',
        '示例：',
        '  输入：l i m x->0 (1+x+x2/2-x) 1/sin3x = e1/2',
        '  输出：[STATEMENT]\\n$\\lim_{x\\to 0}\\left(1+x+\\frac{x^{2}}{2}-x\\right)^{\\frac{1}{\\sin^{3}x}}=e^{1/2}$\\n[NOTE]\\n无',
        '',
        '输出用两段：',
        '[STATEMENT]',
        '规范化后的题干（含中文）',
        '[NOTE]',
        '一句话说明哪些地方你没把握（没有就写：无）'
      ].join('\n')
    };
    const userMsg = {
      role: 'user',
      content: 'OCR 原文：\n' + raw + (body.problem ? '\n\n（这是题目「' + String(body.problem).slice(0, 60) + '」的解题过程识别结果）' : '')
    };

    let out = '';
    for (const cfg of llmCandidates(body.llm || null)) {
      try {
        const t = await callLLM(cfg, [sys, userMsg]);
        if (t && t.trim()) { out = t.trim(); break; }
      } catch (e) {
        console.error('[ocr-fix] ' + cfg.name + ' 失败:', e.message);
      }
    }
    if (!out) {
      // 没有可用模型：原样返回，前端会提示「未规范化」
      return send(res, 200, { ok: true, text: raw, polished: false });
    }
    const m = out.match(/\[STATEMENT\]([\s\S]*?)(?=\[NOTE\]|$)/);
    const text = (m ? m[1] : out).trim();
    const noteM = out.match(/\[NOTE\]([\s\S]*)$/);
    return send(res, 200, {
      ok: true,
      text: text || raw,
      note: noteM ? noteM[1].trim() : '',
      polished: true
    });
  }

  /* ---- 识图：用视觉模型把图片补全成完整题目 ---- */
  if (pathname === '/api/ai/from-image' && method === 'POST') {
    if (!user) return fail(res, 401, '登录后才能用识图补全');
    const body = await readBody(req, 8 * 1024 * 1024);
    const image = typeof body.image === 'string' && body.image.indexOf('data:image/') === 0 ? body.image : '';
    if (!image) return fail(res, 400, '先上传一张题目图片');
    const own = userLlmConfig(body);
    // 先试用户自己的 Key，再试服务端配置/免费通道里能看图的模型；
    // 都没有才让前端回退 tesseract（数学公式识别很差，只作兜底）
    const visionCfgs = [];
    if (own && VISION_MODEL.test(own.model || '')) visionCfgs.push(own);
    for (const cfg of llmCandidates(body)) {
      if (!VISION_MODEL.test(cfg.model || '')) continue;
      if (visionCfgs.some((c) => c.name === cfg.name && c.model === cfg.model)) continue;
      visionCfgs.push(cfg);
    }
    if (!visionCfgs.length) {
      return send(res, 200, { ok: true, needVision: true, prompt: OCR_PROMPT });
    }
    let out = '';
    let used = null;
    const errors = [];
    for (const cfg of visionCfgs) {
      try {
        out = await callLLM(cfg, [
          { role: 'system', content: OCR_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: '按格式转写这张图里的题目。公式用 LaTeX，不要把水印或页眉页脚写进去。' },
              { type: 'image_url', image_url: { url: image } }
            ]
          }
        ]);
        if (out && out.trim()) { used = cfg; break; }
      } catch (e) {
        errors.push(cfg.name + ': ' + e.message);
        console.error('[from-image] ' + cfg.name + ' 失败:', e.message);
      }
    }
    if (!out) return fail(res, 502, '识图模型调用失败：' + (errors[0] || '无可用通道'));
    const raw = parseGenerated(out) || parseTaggedInline(out) || extractJson(out);
    let item = validateFromImage(raw);
    let plain = false;
    if (!item) {
      // 模型直接吐纯 LaTeX（不按 [TITLE] 分段）：整段当题干，后面照样补全其余字段
      const text = normalizeSectionMarks(out)
        .replace(new RegExp('\\[(' + SECTION_NAMES + ')\\][ \\t:：]*', 'gi'), '\n')
        .replace(/```[a-z]*/gi, '').replace(/```/g, '')
        .replace(/\n{3,}/g, '\n\n').trim();
      if (text.length < 8) {
        return send(res, 200, { ok: true, needVision: false, parsed: false, prompt: OCR_PROMPT, raw: String(out).slice(0, 800) });
      }
      item = {
        title: '', statement: text.slice(0, 4000), tags: [], answer: '',
        solution: '', hints: [], thinking: 5, difficulty: 5, calc: 5, source: ''
      };
      plain = true;
    }
    // 标题/答案/解析（图片常没有）用识图成功的同一个模型补全，字段各归其位；
    // 题干始终以视觉转写为准，不被补全模型改写。
    const needMeta = !item.title || !item.answer || !item.solution || !item.tags.length;
    if (needMeta) {
      const done = await completeProblemMeta(item.statement, visionCfgs);
      if (done) {
        const m = done.out;
        if (!item.title) item.title = m.title;
        if (!item.tags.length) item.tags = m.tags;
        if (!item.hints.length) item.hints = m.hints;
        if (!item.answer) item.answer = m.answer;
        if (!item.solution) item.solution = m.solution;
        ['thinking', 'difficulty', 'calc'].forEach((k) => {
          if (m[k] && (!item[k] || item[k] === 5)) item[k] = m[k];
        });
      }
    }
    if (!item.title) {
      item.title = '待命名 · ' + (item.tags || []).slice(0, 2).join(' / ') || '待命名题目';
    }
    return send(res, 200, {
      ok: true, plain: plain, problem: item,
      model: { provider: used.name, model: used.model }
    });
  }

  /* ---- OCR 坏例采集：用户纠错前后的对照，用来量化改进 ---- */
  if (pathname === '/api/ai/ocr-badcase' && method === 'POST') {
    if (!user) return fail(res, 401, '登录后才能提交');
    const body = await readBody(req, 512 * 1024);
    const raw = String(body.raw || '').slice(0, 4000);
    const final = String(body.final || '').slice(0, 4000);
    if (!raw || !final) return fail(res, 400, '缺少识别结果或改正结果');
    if (raw === final) return send(res, 200, { ok: true, skipped: '未修改，不计入坏例' });
    db.ocrBadcases = db.ocrBadcases || [];
    db.ocrBadcases.push({
      id: 'BC' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      at: new Date().toISOString(),
      uid: user.id, name: user.name,
      raw, final,
      conf: Number(body.conf) || 0,
      variant: String(body.variant || '').slice(0, 20),
      quality: body.quality || null,
      code: String(body.code || '').slice(0, 20)
    });
    if (db.ocrBadcases.length > 500) db.ocrBadcases = db.ocrBadcases.slice(-500);
    saveDb();
    return send(res, 200, { ok: true });
  }

  /* ---- 出题提示词（给浏览器直连免费通道用） ---- */
  if (pathname === '/api/ai/prompt' && method === 'POST') {
    if (!user) return fail(res, 401, '登录后才能使用 AI 接口');
    const body = await readBody(req, 64 * 1024);
    const spec = {
      mainTag: String(body.mainTag || '').slice(0, 20),
      tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 4) : [],
      thinking: clampScore(body.thinking, 6),
      difficulty: clampScore(body.difficulty, 6),
      calc: clampScore(body.calc, 5),
      style: String(body.style || '').slice(0, 40),
      note: String(body.note || '').slice(0, 160)
    };
    return send(res, 200, { ok: true, messages: buildGenerateMessages(spec) });
  }

  /* ---- 校验浏览器拿回来的生成结果 ---- */
  if (pathname === '/api/ai/parse' && method === 'POST') {
    if (!user) return fail(res, 401, '登录后才能使用 AI 接口');
    const body = await readBody(req, 256 * 1024);
    const parsed = validateGenerated(parseGenerated(body.text) || extractJson(body.text));
    if (!parsed) return fail(res, 422, 'AI 返回的题目不完整，换一次试试');
    return send(res, 200, { ok: true, problem: parsed });
  }

  /* ---- AI 出题 ---- */
  if (pathname === '/api/ai/generate' && method === 'POST') {
    if (!user) return fail(res, 401, '登录后才能使用 AI 接口');
    const body = await readBody(req, 256 * 1024);
    const spec = {
      mainTag: String(body.mainTag || '').slice(0, 20),
      tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 4) : [],
      thinking: clampScore(body.thinking, 6),
      difficulty: clampScore(body.difficulty, 6),
      calc: clampScore(body.calc, 5),
      style: String(body.style || '').slice(0, 40),
      note: String(body.note || '').slice(0, 160)
    };
    const messages = buildGenerateMessages(spec);
    const errors = [];
    for (const cfg of llmCandidates(body)) {
      try {
        const text = await callLLM(cfg, messages);
        const parsed = validateGenerated(parseGenerated(text) || extractJson(text));
        if (parsed) {
          return send(res, 200, {
            ok: true,
            problem: parsed,
            model: { mode: cfg.mode, provider: cfg.name, model: cfg.model }
          });
        }
        errors.push(cfg.name + '：返回内容不完整');
      } catch (e) {
        errors.push(cfg.name + '：' + e.message);
      }
    }
    console.error('[generate] 全部通道失败:', errors.join(' | '));
    return fail(res, 502, 'AI 出题失败，换个考点再试，或在「模型」里填自己的 Key');
  }

  /* ---- AI 对话（SSE） ---- */
  if (pathname === '/api/ai/chat' && method === 'POST') {
    if (!user) return fail(res, 401, '登录后才能使用 AI 接口');
    const body = await readBody(req, 512 * 1024);
    const history = Array.isArray(body.messages) ? body.messages : [];
    if (!history.length) return fail(res, 400, '缺少消息');
    const problem = body.problemCode ? db.problems.find((p) => p.code === String(body.problemCode).toUpperCase()) : null;
    const lastUser = [...history].reverse().find((m) => m.role === 'user');
    if (problem && user) {
      user.solved = user.solved || {};
      const rec = user.solved[problem.code];
      if (rec) rec.askedAI = true;
      else user.solved[problem.code] = { at: Date.now(), revealed: false, askedAI: true, done: false };
      saveDb();
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const sendEvent = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

    const messages = llmMessages(problem, history, { expert: body.expert !== false });
    let done = false;

    for (const cfg of llmCandidates(body)) {
      let sentAny = false;
      sendEvent({
        type: 'status',
        text: cfg.mode === 'free' ? '免费通道排队中…' : (cfg.mode === 'user-key' ? '正在请求你的模型…' : '正在请求站点模型…')
      });
      try {
        await streamLLM(cfg, messages, (delta) => {
          if (!sentAny) {
            sentAny = true;
            sendEvent({ type: 'meta', mode: cfg.mode, model: cfg.model, provider: cfg.name });
          }
          sendEvent({ type: 'delta', text: delta });
        });
        if (!sentAny) throw new Error(cfg.name + ' 返回空内容');
        sendEvent({ type: 'done', mode: cfg.mode, provider: cfg.name });
        done = true;
        break;
      } catch (e) {
        console.error('[ai] ' + cfg.name + ' 失败:', e.message);
        if (sentAny) {
          // 已经开始输出，保留已发内容，不再切换通道
          sendEvent({ type: 'done', partial: true, provider: cfg.name });
          done = true;
          break;
        }
      }
    }

    if (done) {
      res.end();
      return;
    }

    sendEvent({ type: 'meta', mode: 'local', model: '本地讲解' });
    const text = localTutorText(problem, lastUser ? lastUser.content : '');
    const chunks = text.match(/[\s\S]{1,16}/g) || [];
    for (const chunk of chunks) {
      sendEvent({ type: 'delta', text: chunk });
      await new Promise((r) => setTimeout(r, 14));
    }
    sendEvent({ type: 'done', mode: 'local', fallback: true });
    res.end();
    return;
  }
  }

  for (const p of ['/api/ai/*']) router.all(p, handle);
  return handle;
};
