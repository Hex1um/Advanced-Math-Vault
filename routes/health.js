/**
 * 站点信息域路由组（v2.0.0 拆分）
 *
 * 健康检查 / 站点统计 / 排行榜。健康检查额外暴露版本、引擎、题量、运行时长与 SQLite WAL 体积，方便外部探针发现磁盘写满。
 *
 * 签名统一为 (router, ctx)：router 负责路径匹配与中间件，ctx 提供 db / services / http。
 * 路由体沿用 server.js 时代的分支写法（pathname + method 判定），
 * 这样拆分本身不改变任何一条接口的行为，便于逐域审查与回归。
 */
'use strict';

const fs = require('node:fs');

module.exports = function registerHealthRoutes(router, ctx) {
  const { send, fail, readBody, clientIp, parseCookies, isHttps } = ctx.http;
  const {
    store,
    mailer,
    configWarnings,
    TRUST_PROXY,
    SITE_NAME,
    VERSION,
    DB_FILE,
    publicUser,
    allTags,
    tagTree,
    examTagCounts,
    FREE_PROVIDERS,
    llmConfigured,
    aiBreakers
  } = ctx.services;

  async function handle(rc) {
    const { req, res, pathname, query, user } = rc;
    const method = req.method;
    const db = ctx.db;
  /* ---- 健康检查（无需登录，只暴露运行状态，不含任何密钥） ---- */
  if (pathname === '/api/health' && method === 'GET') {
    const approved = db.problems.filter((p) => p.status === 'approved').length;
    const m = mailer.describe();
    /* 深度健康检查：探针能提前发现「磁盘写满 / WAL 膨胀 / 通道全挂」这三类慢故障，
       而不是等用户报 500。详细通道数据只给管理员，匿名请求只拿到数量。 */
    let walKB = null;
    if (store.engine === 'sqlite') {
      try {
        const stat = fs.statSync(store.sqliteFile + '-wal');
        walKB = Math.round(stat.size / 1024);
      } catch (e) { walKB = 0; }
    }
    const breakers = typeof aiBreakers === 'function' ? aiBreakers() : {};
    const isAdmin = !!(user && user.role === 'admin');
    return send(res, 200, {
      ok: true,
      site: SITE_NAME,
      version: VERSION,
      uptimeSec: Math.round(process.uptime()),
      problems: approved,
      problemCount: approved,
      users: db.users.length,
      engine: store.engine,
      storageReady: store.engine === 'json' ? fs.existsSync(DB_FILE) : store.ready,
      sqliteWalSizeKB: walKB,
      mail: { provider: m.provider, mode: m.mode },
      trustProxy: TRUST_PROXY,
      aiChannels: Object.keys(breakers).length,
      aiChannelsDetail: isAdmin ? breakers : undefined,
      warnings: configWarnings().length
    });
  }

  /* ---- 站点信息 ---- */
  if (pathname === '/api/meta' && method === 'GET') {
    const approved = db.problems.filter((p) => p.status === 'approved');
    const solvedTotal = db.users.reduce((s, u) => s + Object.keys(u.solved || {}).length, 0);
    return send(res, 200, {
      ok: true,
      site: db.settings.site || db.settings.siteName || '',
      stats: {
        problems: approved.length,
        users: db.users.length,
        posts: db.posts.length,
        solves: solvedTotal,
        pending: db.problems.filter((p) => p.status === 'pending').length,
        feedback: db.feedbacks.filter((f) => (f.status || 'open') === 'open').length,
        tags: allTags().length,
        mainTags: tagTree().length
      },
      tagTree: tagTree(),
      examTags: examTagCounts(),
      llm: {
        configured: llmConfigured(),
        model: llmConfigured() ? db.settings.llm.model : '',
        visionConfigured: !!(db.settings.llmVision && db.settings.llmVision.apiKey),
        visionModel: (db.settings.llmVision && db.settings.llmVision.model) || '',
        free: FREE_PROVIDERS.map((f) => f.name)
      },
      me: publicUser(user, true)
    });
  }

  /* ---- 排行榜 ---- */
  if (pathname === '/api/leaderboard' && method === 'GET') {
    // 全站账号都列出来（按经验、做出题数排序），不再只给前 10 名
    const all = db.users.slice()
      .map((u) => publicUser(u))
      .sort((a, b) => (b.exp - a.exp) || (b.solvedCount - a.solvedCount) || String(a.name).localeCompare(String(b.name)))
      .map((u, i) => Object.assign({ rank: i + 1 }, u));
    return send(res, 200, { ok: true, total: all.length, items: all.slice(0, 200) });
  }
  }

  for (const p of ['/api/health', '/api/meta', '/api/leaderboard']) router.all(p, handle);
  return handle;
};
