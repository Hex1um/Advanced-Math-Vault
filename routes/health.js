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
    methodCounts,
    courseCounts,
    subjectCounts,
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
      commit: (ctx.config && ctx.config.commit) || '',
      builtAt: (ctx.config && ctx.config.builtAt) || '',
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
    const counts = subjectCounts();
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
        /* 默认仍是数学口径：旧前端只认 tags / mainTags，口径不能变 */
        tags: allTags().length,
        mainTags: tagTree().length,
        bySubject: counts
      },
      tagTree: tagTree(),
      /* 多学科：前端顶栏切换时直接用这两份树，不必为每个学科再发一次请求。
         物理的 methodCounts 是「物理思想」筛选的来源。 */
      subjects: require('../tag-taxonomy').allSubjectInfos().map((s) => Object.assign({}, s, {
        problems: counts[s.key] || 0
      })),
      tagTrees: { math: tagTree('math'), physics: tagTree('physics') },
      methods: { math: [], physics: methodCounts('physics') },
      /* 课程组：物理三级筛选的第一层（普物 / 数理方法 / 四大力学 / 天文 / 实验） */
      courses: { math: [], physics: courseCounts('physics') },
      courseTree: require('../tag-taxonomy').courseTreeOf('physics'),
      examTags: examTagCounts(),
      /* 前端据此决定是否显示「分析 / 题单 / 期末突击」入口：
         旧后端没有这些接口，隐藏比点了报错更体面。 */
      features: {
        analytics: true,
        collections: true,
        equivalentJudge: true,
        sprint: true,
        /* v2.7.0 多学科：前端据此决定是否显示 [ 数学 | 物理 ] 切换器。
           旧后端没有该字段 → 前端按单学科（数学）渲染，行为不变。 */
        physics: true,
        physicsJudge: true,
        /* 背单词依赖科目包里的 vocabFile，没词库时不亮这个能力，前端就不加那个 Tab */
        vocab: !!(ctx.sprint && ctx.sprint.list().some((p) => p.counts && p.counts.vocab > 0))
      },
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
