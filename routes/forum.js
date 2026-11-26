/**
 * 答疑区域路由组（v2.0.0 拆分）
 *
 * 帖子列表 / 详情 / 发帖 / 回复 / 删除 / 标记已解决 / AI 起标题。
 *
 * 签名统一为 (router, ctx)：router 负责路径匹配与中间件，ctx 提供 db / services / http。
 * 路由体沿用 server.js 时代的分支写法（pathname + method 判定），
 * 这样拆分本身不改变任何一条接口的行为，便于逐域审查与回归。
 */
'use strict';

module.exports = function registerForumRoutes(router, ctx) {
  const { send, fail, readBody, clientIp, parseCookies, isHttps } = ctx.http;
  const {
    saveDb,
    bumpView,
    TRUST_PROXY,
    allTags,
    logActivity,
    ai,
    llmCandidates,
    callLLM,
    scheduleForumReply,
    postQuota,
    noteQuota,
    saveUploads
  } = ctx.services;

  async function handle(rc) {
    const { req, res, pathname, query, user } = rc;
    const method = req.method;
    const db = ctx.db;
  /* ---- 答疑区 ---- */
  if (pathname === '/api/forum' && method === 'GET') {
    const page = Math.max(1, Number(query.page || 1));
    const size = Number(query.size || 12);
    const q = String(query.q || '').trim().toLowerCase();
    const codeFilter = String(query.code || '').trim().toUpperCase();
    let list = db.posts.slice();
    if (codeFilter) list = list.filter((p) => p.problemCode === codeFilter);
    if (q) list = list.filter((p) => (p.title + ' ' + p.body).toLowerCase().includes(q));
    list.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    const total = list.length;
    return send(res, 200, {
      ok: true,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / size)),
      items: list.slice((page - 1) * size, page * size).map((p) => ({
        id: p.id, title: p.title, tags: p.tags, authorName: p.authorName,
        replyCount: p.replies.length, createdAt: p.createdAt,
        excerpt: String(p.body || '').replace(/\s+/g, ' ').slice(0, 120),
        image: p.image || '',
        imageCount: (Array.isArray(p.images) ? p.images.length : (p.image ? 1 : 0)),
        updatedAt: p.updatedAt || p.createdAt, problemCode: p.problemCode,
        solved: !!p.solved
      })),
      hot: allTags().slice(0, 8)
    });
  }

  if (pathname === '/api/forum/suggest-title' && method === 'POST') {
    if (!user) return fail(res, 401, '请先登录');
    const body = await readBody(req);
    const text = String(body.body || '').trim();
    if (text.length < 10) return fail(res, 400, '正文太短，先写几句再让 AI 起标题');

    const sys = {
      role: 'system',
      content: [
        '你是数学答疑区的标题助手。根据帖子正文起一个标题。',
        '要求：6-20 个字；点出卡在哪一步或核心疑问；不要加书名号引号；',
        '不要用「求助」「请问」这类空话开头；只输出标题本身，不要解释、不要句末标点。'
      ].join('\n')
    };
    const userMsg = { role: 'user', content: '正文：\n' + text.slice(0, 1200) };
    let title = '';
    for (const cfg of llmCandidates(body.llm || null)) {
      try {
        const t = await callLLM(cfg, [sys, userMsg]);
        if (t && t.trim()) {
          title = t.trim().split('\n')[0].replace(/^[「『"'《]+|[」』"'》]+$/g, '').replace(/[。.]$/, '');
          break;
        }
      } catch (e) { console.error('[title-ai] ' + cfg.name + ' 失败:', e.message); }
    }
    if (!title) title = text.replace(/\s+/g, ' ').slice(0, 20);
    return send(res, 200, { ok: true, title: title.slice(0, 40) });
  }

  if (pathname === '/api/forum' && method === 'POST') {
    if (!user) return fail(res, 401, '请先登录再发帖');
    // 防恶意注册：没绑定邮箱的账号，每小时只能发 1 条帖
    const quota = postQuota(user);
    if (quota.blocked) return fail(res, 429, quota.message);
    const body = await readBody(req);
    const title = String(body.title || '').trim();
    const content = String(body.body || '').trim();
    const images = saveUploads(body);
    if (title.length < 4) return fail(res, 400, '标题至少 4 个字');
    if (content.length < 6 && !images.length) return fail(res, 400, '正文至少 6 个字（或者直接传一张图）');
    let tags = body.tags;
    if (typeof tags === 'string') tags = tags.split(/[,，、\s]+/);
    tags = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 4) : [];
    const problemCode = String(body.problemCode || '').trim().toUpperCase();
    if (problemCode && !db.problems.some((p) => p.code === problemCode)) return fail(res, 400, '关联题目编号不存在');
    const post = {
      id: db.meta.postSeq++,
      title: title.slice(0, 100),
      body: content,
      tags,
      problemCode: problemCode || '',
      image: images[0] || '',
      images: images,
      authorId: user.id,
      authorName: user.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      solved: false,
      replies: []
    };
    db.posts.push(post);
    noteQuota(user, false);
    saveDb();
    scheduleForumReply(post.id);
    return send(res, 200, { ok: true, id: post.id });
  }

  const postMatch = pathname.match(/^\/api\/forum\/(\d+)(\/reply|\/solve|\/delete)?$/);
  if (postMatch) {
    const id = Number(postMatch[1]);
    const sub = postMatch[2];
    const post = db.posts.find((p) => p.id === id);
    if (!post) return fail(res, 404, '帖子不存在');
    const problem = post.problemCode ? db.problems.find((p) => p.code === post.problemCode) : null;

    if (!sub && method === 'GET') {
      if (bumpView('post', post.id, clientIp(req, { trustProxy: TRUST_PROXY }))) post.views = (post.views || 0) + 1;
      return send(res, 200, {
        ok: true,
        post: {
          id: post.id, title: post.title, body: post.body, tags: post.tags,
          authorName: post.authorName, authorId: post.authorId,
          createdAt: post.createdAt, views: post.views || 0,
          problemCode: post.problemCode,
          problem: problem ? { code: problem.code, title: problem.title } : null,
          images: Array.isArray(post.images) && post.images.length ? post.images : (post.image ? [post.image] : []),
          solved: !!post.solved,
          replies: post.replies
        }
      });
    }

    if (sub === '/reply' && method === 'POST') {
      if (!user) return fail(res, 401, '请先登录再回复');
      // 防恶意注册：未绑定邮箱每小时只能回 1 条
      const q = postQuota(user, true);
      if (q.blocked) return fail(res, 429, q.message);
      const body = await readBody(req);
      const content = String(body.body || '').trim();
      const images = saveUploads(body);
      if (content.length < 2 && !images.length) return fail(res, 400, '回复不能为空');
      const replyId = db.meta.replySeq++;
      const mentionAI = /@\s*(?:AI\s*助教|AI|ai|助教)/.test(content);
      post.replies.push({
        id: replyId,
        authorId: user.id,
        authorName: user.name,
        isAI: false,
        body: content.slice(0, 4000),
        images,
        createdAt: new Date().toISOString()
      });
      post.updatedAt = new Date().toISOString();
      noteQuota(user, true);
      logActivity(user, '在答疑区回复了 #' + post.id, '');
      saveDb();
      // 回复里 @ 了 AI 助教：让 AI 针对这条回复再答一次
      if (mentionAI) scheduleForumReply(post.id, { ask: content, afterReplyId: replyId });
      return send(res, 200, { ok: true, id: replyId, aiAsked: mentionAI });
    }

    if (sub === '/delete' && method === 'POST') {
      if (!user) return fail(res, 401, '请先登录');
      const isOwner = post.authorId === user.id;
      const isAdmin = user.role === 'admin';
      if (!isOwner && !isAdmin) return fail(res, 403, '只能删除自己的帖子');
      db.posts = db.posts.filter((p) => p.id !== post.id);
      saveDb();
      if (isAdmin && !isOwner) logActivity(user, '管理员删除了帖子 #' + post.id, '');
      return send(res, 200, { ok: true });
    }

    if (sub === '/solve' && method === 'POST') {
      if (!user) return fail(res, 401, '请先登录');
      if (user.id !== post.authorId && (!user || user.role !== 'admin')) return fail(res, 403, '只有楼主或管理员可以标记已解决');
      post.solved = true;
      post.updatedAt = new Date().toISOString();
      saveDb();
      return send(res, 200, { ok: true });
    }
  }
  }

  for (const p of ['/api/forum', '/api/forum/*']) router.all(p, handle);
  return handle;
};
