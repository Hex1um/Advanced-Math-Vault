/**
 * 个性化题单 / 冲刺包路由组（v2.0.0 新增）
 *
 * 学生在不同阶段的需求差异很大：期中急救、考研数一/数二、竞赛初赛、教材同步。
 * 题单把 6260 道题组织成可分享、可追踪完成率的专题包。
 *
 * 权限模型：
 *   - 所有人可读公开题单；登录用户可读自己的私有题单；
 *   - 任何人可自建私有题单；只有管理员能建「公开」官方题单（避免刷屏与内容失控）；
 *   - 只有创建者或管理员能增删题单里的题目。
 */
'use strict';

const crypto = require('node:crypto');
const { requireAuth } = require('../lib/router');

module.exports = function registerCollectionsRoutes(router, ctx) {
  const { send, fail, readBody } = ctx.http;

  function ensureList() {
    if (!Array.isArray(ctx.db.collections)) ctx.db.collections = [];
    return ctx.db.collections;
  }

  function solvedSetOf(user) {
    if (!user) return new Set();
    const out = new Set();
    for (const [code, rec] of Object.entries(user.solved || {})) {
      if (rec && rec.done) out.add(code);
    }
    return out;
  }

  /* 公开题单 + 当前用户自建题单 */
  router.get('/api/collections', async ({ res, user }) => {
    const list = ensureList();
    const visible = list
      .filter((c) => c.isPublic || (user && c.ownerId === user.id))
      .map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description || '',
        isPublic: !!c.isPublic,
        ownerName: c.ownerName || '',
        count: (c.problemCodes || []).length,
        updatedAt: c.updatedAt || c.createdAt || 0,
        mine: !!(user && c.ownerId === user.id),
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    send(res, 200, { ok: true, collections: visible, total: visible.length });
  });

  /* 题单详情：附带当前用户的完成进度 */
  router.get('/api/collections/:id', async ({ res, params, user }) => {
    const col = ensureList().find((c) => c.id === params.id);
    if (!col || (!col.isPublic && (!user || col.ownerId !== user.id))) {
      return fail(res, 404, '题单不存在或无权访问');
    }
    const probMap = new Map((ctx.db.problems || []).map((p) => [p.code, p]));
    const solved = solvedSetOf(user);
    const items = (col.problemCodes || [])
      .map((code) => probMap.get(code))
      .filter((p) => p && p.status === 'approved')
      .map((p) => ({
        code: p.code,
        title: p.title,
        mainTag: p.mainTag,
        difficulty: p.difficulty,
        tags: (p.tags || []).slice(0, 2),
        solved: solved.has(p.code),
      }));
    send(res, 200, {
      ok: true,
      id: col.id,
      title: col.title,
      description: col.description || '',
      isPublic: !!col.isPublic,
      ownerName: col.ownerName || '',
      mine: !!(user && col.ownerId === user.id),
      items,
      solvedCount: items.filter((i) => i.solved).length,
      totalCount: items.length,
    });
  });

  router.post('/api/collections', requireAuth, async ({ req, res, user }) => {
    const body = await readBody(req, 256 * 1024);
    const title = String(body.title || '').trim().slice(0, 60);
    if (!title) return fail(res, 400, '题单标题不能为空');

    const codes = Array.isArray(body.problemCodes) ? [...new Set(body.problemCodes.map(String))] : [];
    const known = new Set((ctx.db.problems || []).map((p) => p.code));
    const col = {
      id: 'col_' + crypto.randomBytes(6).toString('hex'),
      ownerId: user.id,
      ownerName: user.name,
      title,
      description: String(body.description || '').trim().slice(0, 300),
      isPublic: Boolean(body.isPublic && user.role === 'admin'),
      problemCodes: codes.filter((c) => known.has(c)).slice(0, 200),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    ensureList().push(col);
    ctx.saveDb('collection:create');
    send(res, 201, Object.assign({ ok: true }, col));
  });

  router.patch('/api/collections/:id', requireAuth, async ({ req, res, params, user }) => {
    const col = ensureList().find((c) => c.id === params.id);
    if (!col) return fail(res, 404, '题单不存在');
    if (col.ownerId !== user.id && user.role !== 'admin') {
      return fail(res, 403, '仅创建者或管理员可修改题单');
    }
    const body = await readBody(req, 256 * 1024);
    if (body.title !== undefined) {
      const title = String(body.title).trim().slice(0, 60);
      if (!title) return fail(res, 400, '题单标题不能为空');
      col.title = title;
    }
    if (body.description !== undefined) col.description = String(body.description).trim().slice(0, 300);
    if (body.isPublic !== undefined) col.isPublic = Boolean(body.isPublic && user.role === 'admin');
    col.updatedAt = Date.now();
    ctx.saveDb('collection:update');
    send(res, 200, Object.assign({ ok: true }, col));
  });

  /* 批量加/移题目：add / remove 两个数组，单次最多 200 题 */
  router.patch('/api/collections/:id/items', requireAuth, async ({ req, res, params, user }) => {
    const col = ensureList().find((c) => c.id === params.id);
    if (!col) return fail(res, 404, '题单不存在');
    if (col.ownerId !== user.id && user.role !== 'admin') {
      return fail(res, 403, '仅创建者或管理员可修改题单');
    }
    const body = await readBody(req, 256 * 1024);
    const known = new Set((ctx.db.problems || []).map((p) => p.code));
    const set = new Set(col.problemCodes || []);
    for (const c of Array.isArray(body.add) ? body.add : []) {
      const code = String(c);
      if (known.has(code)) set.add(code);
    }
    for (const c of Array.isArray(body.remove) ? body.remove : []) set.delete(String(c));
    col.problemCodes = [...set].slice(0, 200);
    col.updatedAt = Date.now();
    ctx.saveDb('collection:items');
    send(res, 200, Object.assign({ ok: true }, col));
  });

  router.delete('/api/collections/:id', requireAuth, async ({ res, params, user }) => {
    const list = ensureList();
    const col = list.find((c) => c.id === params.id);
    if (!col) return fail(res, 404, '题单不存在');
    if (col.ownerId !== user.id && user.role !== 'admin') {
      return fail(res, 403, '仅创建者或管理员可删除题单');
    }
    ctx.db.collections = list.filter((c) => c.id !== params.id);
    ctx.saveDb('collection:delete');
    send(res, 200, { ok: true });
  });
};
