/**
 * 数海晴岸 · 零依赖后端（v2.0.0 组合根）
 *
 * 这个文件现在只做「组装」：
 *   - 读配置、建存储与邮件通道、建业务核心（lib/core.js）
 *   - 建统一上下文 ctx（lib/context.js）与路由器（lib/router.js）
 *   - 按域挂载 routes/*.js
 *   - 处理静态资源、CSP、生命周期（备份 / 优雅停机 / 兜底）
 *
 * 业务逻辑不再堆在这里：拆分前 3522 行的单文件已按域收敛，
 * 每个路由模块都在 100～500 行，改动一个域不用再通读全站。
 */
'use strict';

const http = require('http');
const path = require('path');

const config = require('./lib/config');
const httpLib = require('./lib/http');
const { createStore } = require('./lib/store');
const { createMailer } = require('./lib/mail');
const tagTax = require('./tag-taxonomy');
const fsrs = require('./lib/fsrs');
const createCore = require('./lib/core');
const { createAppContext } = require('./lib/context');
const { Router, rateRulesMiddleware } = require('./lib/router');

const { send, fail, applyCors, serveStatic } = httpLib;
const { fail500 } = httpLib;
const { PORT, HOST, SITE_NAME, VERSION, PUBLIC_DIR, DATA_DIR, UPLOAD_DIR } = config;

/* 存储与邮件：JSON / SQLite 由 DB_ENGINE 决定；邮件未配置时自动降级为日志模式 */
const store = createStore({ engine: process.env.DB_ENGINE, dbFile: config.DB_FILE, dataDir: DATA_DIR });
const mailer = createMailer();

const core = createCore({ store, mailer });

const ctx = createAppContext({
  store,
  ai: core.ai,
  mail: mailer,
  fsrs,
  http: httpLib,
  ratelimit: {
    hit: core.rateLimit,
    allow: (key, limit, windowMs) => core.rateLimit(key, limit, windowMs),
  },
  taxonomy: tagTax,
  config: {
    ...config,
    trustProxy: core.TRUST_PROXY,
    allowOrigins: core.ALLOWED_ORIGINS,
    commit: config.BUILD_INFO.commit,
    builtAt: config.BUILD_INFO.builtAt
  },
  services: core,
  helpers: { ...core, clientIp: httpLib.clientIp },
});
ctx.setDb(core.db);

/* 期末突击（v1.6.0）：科目包只读加载，用户进度写 db.sprint。
   在 core.loadDb() 之后再 load()，因为引用型题目要按编号从题库取题。 */
const createSprint = require('./lib/sprint');
ctx.sprint = createSprint({
  dir: path.join(DATA_DIR, 'subjects'),
  getDb: () => core.db,
  fsrs: fsrs,
  log: (m) => console.log(m)
});

const router = new Router();
router.use(rateRulesMiddleware(core.RATE_RULES, { trustProxy: core.TRUST_PROXY }));

/* 路由按域挂载。顺序即优先级：先挂精确前缀，再挂通配。 */
for (const mod of [
  './routes/health',
  './routes/auth',
  './routes/practice',
  './routes/wrongbook',
  './routes/analytics',
  './routes/forum',
  './routes/paper',
  './routes/me',
  './routes/ai',
  './routes/admin',
  './routes/sprint',
  './routes/collections',
  './routes/problems',
]) {
  const register = require(mod);
  if (typeof register === 'function') register(router, ctx);
}

/* 安全响应头：KaTeX / Tesseract 全部本地化，因此可以上严格 CSP，不依赖任何外网 CDN。
   wasm-unsafe-eval 给 Tesseract 的 WASM 编译用；worker-src blob: 给它的 Worker 包装层。 */
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' https:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

/**
 * API 错误统一出口。
 *
 * 4xx（readBody 的 400/413 等）按原样回显：这类是客户端错误，消息本身就是给用户看的；
 * 其余一律走 fail500 脱敏（只给 reqId，堆栈进日志）。
 *
 * 413 额外处理：请求体还没读完就被拒，直接 destroy 会让客户端只看到 ECONNRESET，
 * 连 413 的响应体都收不到。先把响应写完（res 的 finish 事件），再掐连接。
 */
function handleApiError(req, res, e, pathname) {
  const status = Number(e && e.status);
  if (status >= 400 && status < 500 && e.expose !== false) {
    if (status === 413) {
      res.on('finish', () => { try { req.destroy(); } catch (_) { /* 已断开 */ } });
    }
    if (!res.headersSent && !res.destroyed) fail(res, status, e.message);
    else if (!res.writableEnded) res.end();
    return;
  }
  fail500(res, e, {
    tag: req.method + ' ' + pathname,
    dev: process.env.NODE_ENV === 'development',
    log: console.error
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const pathname = parsed.pathname;
    const query = Object.fromEntries(parsed.searchParams.entries());

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

    applyCors(req, res, core.ALLOWED_ORIGINS);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (pathname.startsWith('/api/')) {
      try {
        const user = core.currentUser(req);
        const matched = await router.dispatch(req, res, ctx, { pathname, query, user });
        if (!res.writableEnded) {
          if (!matched) {
            fail(res, 404, '接口不存在');
          } else {
            /* 命中了路由却没写响应 —— 这是 handler 的真实 bug，不能回 404 假装「路径不存在」，
               否则前端只会以为是接口改了名，日志里什么都查不到。 */
            fail500(res, new Error('handler 未产生响应'), {
              tag: req.method + ' ' + pathname,
              dev: process.env.NODE_ENV === 'development',
              log: console.error
            });
          }
        }
      } catch (e) {
        handleApiError(req, res, e, pathname);
      }
      return;
    }

    serveStatic(req, res, pathname, { publicDir: PUBLIC_DIR, uploadDir: UPLOAD_DIR });
  } catch (e) {
    console.error('[http] 未捕获异常:', req.method, req.url, (e && e.stack) || e);
    try {
      if (!res.headersSent && !res.destroyed) fail(res, 500, '服务器内部错误');
      else if (!res.writableEnded) res.end();
    } catch (e2) { /* 响应已经结束 */ }
  }
});

/* 兜底策略：
   - uncaughtException：内存状态可能已经半损坏，继续跑会把脏数据写进库。
     记录完整堆栈 → 尽力刷一次盘 → 以非零码退出，交给进程守护重启。
   - unhandledRejection：多数是某个 await 忘了 catch，不足以证明状态损坏，
     只记录不退出（否则一个第三方 SDK 的 rejection 就能把站点打下线）。 */
process.on('uncaughtException', (e) => {
  console.error('[uncaught]', (e && e.stack) || e);
  try {
    core.flushViews();
    if (store.engine === 'sqlite') { core.saveDb(true); store.close(core.db); }
    else core.writeDbFile();
  } catch (e2) {
    console.error('[uncaught] 退出前落盘失败:', e2.message);
  }
  process.exit(1);
});
/* 只记录不退出是对的，但「只记录」有个副作用：漏了 await 的链路一小时刷几百条警告，
   淹在日志里就没人看了。这里加计数器，每累计 N 次升一级提示：要么去修，要么说明
   某个降级路径在稳定地失败。阈值可用 REJECTION_WARN_EVERY 调。 */
const REJECTION_WARN_EVERY = Math.max(5, Number(process.env.REJECTION_WARN_EVERY || 50));
let rejectionCount = 0;
process.on('unhandledRejection', (e) => {
  rejectionCount += 1;
  const detail = (e && e.stack) || e;
  if (rejectionCount % REJECTION_WARN_EVERY === 0) {
    console.error('[unhandledRejection] 累计 ' + rejectionCount + ' 次未处理的 rejection：'
      + '多半是某个 await 漏了 catch，或降级分支在稳定失败。最近一次：', detail);
  } else {
    console.error('[unhandledRejection] #' + rejectionCount, detail);
  }
});

core.loadDb();
ctx.setDb(core.db);
ctx.sprint.load();

/* 先消费一次性管理员重置（scrypt 已异步化，必须等它落盘后再对外提供服务），
   再开始监听。失败不影响启动：紧急通道坏掉不该让站点起不来。 */
core.applyOpsReset()
  .catch((e) => console.error('[ops] 重置流程异常:', e && e.message))
  .finally(() => startServer());

function startServer() {
  server.listen(PORT, HOST, () => {
    const db = core.db;
    console.log(SITE_NAME + ' v' + VERSION + ' running at http://localhost:' + PORT);
    console.log('题目数:', db.problems.filter((p) => p.status === 'approved').length, '| 用户数:', db.users.length, '| LLM:', core.llmConfigured() ? db.settings.llm.model : '本地讲解模式');
    console.log('存储:', store.engine === 'sqlite' ? 'SQLite ' + store.sqliteFile : 'JSON ' + config.DB_FILE, '| 邮件:', mailer.describe().provider + (mailer.describe().mode === 'log' ? '（日志模式）' : ''));
    const warns = core.configWarnings();
    if (warns.length) {
      console.log('— 上线配置提醒 —');
      for (const w of warns) console.log('  · ' + w);
    }
    // 启动即做一次当日备份；之后每 30 分钟检查一次是否跨天
    core.dailyBackup();
    setInterval(() => core.dailyBackup(), 30 * 60 * 1000).unref();
    // SQLite 引擎下定期把 db.json 镜像刷新一遍，保证按 db.json 工作的老工具与部署流程拿到的不是陈旧数据
    if (store.engine === 'sqlite') {
      setInterval(() => {
        try { store.save(core.db); store.mirror(core.db); } catch (e) { console.error('[store] 定期镜像失败:', e.message); }
      }, 10 * 60 * 1000).unref();
    }
    if (/^prod/i.test(String(process.env.NODE_ENV || '')) && core.ALLOWED_ORIGINS.includes('*')) {
      console.warn('[cors] 生产环境 ALLOW_ORIGINS=*：任何站点都能调用本站接口，请尽快改成白名单');
    }
  });
}

let shuttingDown = false;

/* 优雅停机：先停止接收新连接，再把内存里攒的计数与库落盘。
   顺序很重要——先 close() 才不会出现「新请求进来改了内存、落盘却已经做过」的丢写。 */
function shutdown(signal, code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[shutdown] ' + signal + '，停止接收新连接并落盘…');
  try {
    server.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  } catch (e) { /* 还没 listen 就退出时会抛，忽略 */ }
  try {
    const flushed = core.flushViews();
    if (flushed) console.log('[shutdown] 已刷入 ' + flushed + ' 次浏览/AI 统计');
    if (store.engine === 'sqlite') {
      store.save(core.db);
      store.mirror(core.db);
      store.close(core.db);
    } else {
      core.writeDbFile();
    }
  } catch (e) {
    console.error('[shutdown] 落盘失败:', e.message);
    process.exit(1);
  }
  process.exit(code || 0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { server, ctx, router };
