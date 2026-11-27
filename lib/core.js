/**
 * 业务核心（v2.0.0 架构重构，v3.12.0 二次拆分）
 *
 * 从 server.js 的 3500 行里搬出的「数据层 + 业务工具 + AI 装配 + 判题」，
 * 以工厂函数形式返回一个能力对象：db 通过 getter 始终指向最新引用，
 * 路由模块只依赖 ctx.services / ctx.db，不再需要 28 个散乱入参。
 *
 * v3.12.0 起按域再拆出四个模块（这个文件从 2054 行降到 ~1300 行）：
 *   - lib/auth.js              口令哈希 / 会话 / currentUser / publicUser
 *   - lib/problem-normalize.js mathify / 质量门禁 / 查重 / 字段白名单 / 编号
 *   - lib/judge.js             判题比对 + 四套 Rubric + parseJudge
 *   - lib/gamify.js            等级曲线 / 难度分级 / 经验计算
 * 它们在这里被组合，导出的能力表面（ctx.services.*）保持不变。
 *
 * 约定：
 *   - 这里不 require 任何第三方包；
 *   - 需要读库的拆出模块通过 getDb() 注入，不直接持有库引用 ——
 *     启动时 db 会被整体替换（SQLite attach），拿旧引用的函数会看到过期数据。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const tagTax = require('../tag-taxonomy');
const fsrs = require('./fsrs');
const DAILY_PLAN = require('./daily-plan');
const httpLib = require('./http');
const { createRateLimiter } = require('./ratelimit');
const { createStore } = require('./store');
const { createMailer } = require('./mail');
const gamify = require('./gamify');
const createProblemTools = require('./problem-normalize');
const createAuth = require('./auth');
const judge = require('./judge');
const {
  ROOT, PUBLIC_DIR, DATA_DIR, DB_FILE, SEED_FILE, SITE_NAME, VERSION, EXAM_TAGS, TUNING
} = require('./config');

const { send, fail, readBody, parseCookies, isHttps, clientIp } = httpLib;
const { fail500 } = httpLib;

/* 纯函数直接取到模块作用域：业务闭包里用得太多，逐处 problemTools.xxx 反而噪声 */
const { LEVELS, DIFF_MAX, levelOf, clampScore, levelInfo, xpForProblem } = gamify;
const {
  canonAnswer, numericValue, problemKind, examPoints, answersEquiv, conclusionSegments,
  processMatchesAnswer, judgeMessages, parseJudge, physicsJudgeKind, physicsJudgeSystem,
  theoryJudgeSystem, astroJudgeSystem
} = judge;

module.exports = function createCore(deps) {
  const store = (deps && deps.store) || createStore({ engine: process.env.DB_ENGINE, dbFile: DB_FILE, dataDir: DATA_DIR });
  const mailer = (deps && deps.mailer) || createMailer();
  const limiter = createRateLimiter({ maxBuckets: Number(process.env.RATE_LIMIT_MAX_BUCKETS || 20000) });
  const rateLimit = (key, limit, windowMs) => limiter.hit(key, limit, windowMs);
  setInterval(() => limiter.sweep(), 5 * 60 * 1000).unref();

  /* CORS 白名单与代理信任开关：只在启动时算一次 */
  const ALLOWED_ORIGINS = String(process.env.ALLOW_ORIGINS || '*').split(',').map((x) => x.trim()).filter(Boolean);
  const TRUST_PROXY = /^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY || '');

  /* 拆出去的两组工具：需要读库的那部分走 getDb() 注入，
     这样 loadDb() 里整体替换 db（Spark/SQLite attach）后它们看到的是新引用。 */
  const problemTools = createProblemTools({ getDb: () => db });
  const {
    mathify, qualityGate, dedupeCanon, bigrams, jaccard,
    findDuplicateProblem, normalizeProblem, cleanPhysicsMeta, nextProblemCode
  } = problemTools;

  const authTools = createAuth({
    getDb: () => db,
    parseCookies: parseCookies,
    isHttps: isHttps,
    trustProxy: TRUST_PROXY
  });
  const {
    hashPassword, verifyPassword, sessionKey, bearerToken, sessionCookie, currentUser, publicUser
  } = authTools;

/* ---------------------------------------------------------------- 数据层 */

function emptyDb() {
  return {
    users: [],
    problems: [],
    posts: [],
    sessions: {},
    daily: {},
    submissions: [],
    feedbacks: [],
    emailCodes: {},
    settings: {
      llm: {
        baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
        model: process.env.LLM_MODEL || 'deepseek-chat',
        apiKey: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || ''
      },
      site: SITE_NAME
    },
    meta: { seq: 1001, postSeq: 1, replySeq: 1, feedbackSeq: 1 }
  };
}

let db = emptyDb();
let saveTimer = null;

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* 启动时给现有库留一份快照（保留最近 12 份）。
   目的是：万一某次部署用本地库覆盖了线上，还能从 data/backups 里捞回用户与帖子。 */
function snapshotDb() {
  if (!fs.existsSync(DB_FILE)) return;
  try {
    const dir = path.join(DATA_DIR, 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const stat = fs.statSync(DB_FILE);
    const stamp = new Date(stat.mtime).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(dir, 'db-' + stamp + '.json');
    if (!fs.existsSync(dest)) fs.copyFileSync(DB_FILE, dest);
    const old = fs.readdirSync(dir).filter((f) => /^db-.*\.json$/.test(f)).sort();
    while (old.length > 12) {
      const f = old.shift();
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
  } catch (e) {
    console.error('[db] 快照失败:', e.message);
  }
}

/* 把读进来的原始库补齐字段、校正计数器、归并标签。不碰存储层。 */
function normalizeLoaded() {
  db.settings = Object.assign({ llm: {} }, db.settings || {});
  db.meta = Object.assign({ seq: 1001, postSeq: 1, replySeq: 1 }, db.meta || {});
  if (!Array.isArray(db.problems)) db.problems = [];
  if (!Array.isArray(db.posts)) db.posts = [];
  if (!Array.isArray(db.users)) db.users = [];
  if (!db.sessions || typeof db.sessions !== 'object') db.sessions = {};
  if (!Array.isArray(db.submissions)) db.submissions = [];
  if (!Array.isArray(db.feedbacks)) db.feedbacks = [];
  if (!db.emailCodes || typeof db.emailCodes !== 'object') db.emailCodes = {};
  if (!db.meta.feedbackSeq) db.meta.feedbackSeq = 1;
  // 计数器必须追上已有数据：从线上同步回来的帖子/回复可能比本地 postSeq 还新，
  // 不修正就会「新帖拿到已被占用的 id」，发帖看起来成功、实际写进了别人的帖子。
  const maxOf = (arr, f) => arr.reduce((m, x) => Math.max(m, Number(f(x)) || 0), 0);
  const maxPostId = maxOf(db.posts, (p) => p.id);
  const maxReplyId = db.posts.reduce((m, p) => Math.max(m, maxOf(p.replies || [], (r) => r.id)), 0);
  const maxFeedbackId = maxOf(db.feedbacks, (f) => f.id);
  const maxProblemSeq = db.problems.reduce((m, p) => {
    const n = Number(String(p.code || '').replace(/\D/g, ''));
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 1000);
  db.meta.postSeq = Math.max(Number(db.meta.postSeq) || 1, maxPostId + 1);
  db.meta.replySeq = Math.max(Number(db.meta.replySeq) || 1, maxReplyId + 1);
  db.meta.feedbackSeq = Math.max(Number(db.meta.feedbackSeq) || 1, maxFeedbackId + 1);
  db.meta.seq = Math.max(Number(db.meta.seq) || 1001, maxProblemSeq + 1);
  db.problems.forEach((p) => {
    if (typeof p.scoreSum !== 'number') p.scoreSum = 0;
    if (typeof p.scoreCount !== 'number') p.scoreCount = 0;
    // 学科命名空间：历史题一律回填 math，物理题保留 physics（未知值也归 math）
    p.subject = tagTax.subjectOf(p.subject);
    // 每次启动都过一遍标签体系：老库、线上同步回来的题、AI 草稿都能落到同一套主/子标签上
    const tagInfo = tagTax.normalize(p.tags, p.mainTag, p.subject);
    p.mainTag = tagInfo.mainTag;
    p.tags = tagInfo.tags;
    if (tagInfo.kind && !p.kind) p.kind = tagInfo.kind;
    if (p.difficulty > DIFF_MAX) p.difficulty = DIFF_MAX;
    /* 物理题缺 physicsMeta 时补一个最小对象：判题链路（practice/组卷）需要
       稳定的字段形状，undefined 会让「有没有单位」的判断四处开裂。 */
    if (p.subject === 'physics' && (!p.physicsMeta || typeof p.physicsMeta !== 'object')) {
      p.physicsMeta = { answerType: 'symbolic', unit: '', constants: [], methods: [], diagrams: [] };
    }
    /* 课程组由 mainTag 推导：旧题没有 course 字段也能进「四大力学 / 天文」筛选 */
    if (p.subject === 'physics' && p.physicsMeta) {
      if (!p.physicsMeta.course) p.physicsMeta.course = tagTax.courseOfMain(p.mainTag);
      if (!p.physicsMeta.unitSystem) p.physicsMeta.unitSystem = 'SI';
      if (!Array.isArray(p.physicsMeta.prerequisites)) p.physicsMeta.prerequisites = [];
    }
  });
  db.users.forEach((u) => {
    if (!u.best || typeof u.best !== 'object') u.best = {};
    if (!u.wrong || typeof u.wrong !== 'object') u.wrong = {};
  });
  // 清理过期会话
  const now = Date.now();
  for (const k of Object.keys(db.sessions)) {
    if (!db.sessions[k] || db.sessions[k].exp < now) delete db.sessions[k];
  }
}

/* 加载完成：SQLite 引擎在这里套上变更追踪（Proxy），JSON 引擎原样返回 */
function finishLoad() {
  if (store.engine === 'sqlite') {
    store.open();
    db = store.attach(db);
    if (!store.hasData()) store.importAll(db);
  }
}

/* 库文件不见了但备份还在：直接拿最近一份恢复，总比起一个空库好。
   v0.9.0 那次事故的教训——部署时漏带 db.json，线上用户数据看着就"消失"了。
   只在用默认路径时启用：测试/临时库（显式传 DB_FILE）不受影响，避免测试读到真实备份。 */
function restoreFromBackup() {
  if (fs.existsSync(DB_FILE)) return false;
  if (process.env.DB_FILE || process.env.NO_AUTO_RESTORE === '1') return false;
  const dirs = [path.join(DATA_DIR, 'backups', 'daily'), path.join(DATA_DIR, 'backups')];
  const cands = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/^db-.*\.json$/.test(f)) continue;
      const full = path.join(dir, f);
      try { cands.push({ full, name: f, t: fs.statSync(full).mtimeMs }); } catch (_) {}
    }
  }
  if (!cands.length) return false;
  cands.sort((a, b) => b.t - a.t);
  try {
    fs.copyFileSync(cands[0].full, DB_FILE);
    console.log('[db] 没有找到 ' + path.basename(DB_FILE) + '，已从最近备份恢复：' + cands[0].name);
    return true;
  } catch (e) {
    console.error('[db] 从备份恢复失败:', e.message);
    return false;
  }
}

function loadDb() {
  ensureDirs();
  snapshotDb();
  restoreFromBackup();

  if (store.engine === 'sqlite') {
    try {
      const fromSqlite = store.load();
      if (fromSqlite) {
        db = Object.assign(emptyDb(), fromSqlite);
        normalizeLoaded();
        finishLoad();
        return;
      }
      // 首次切到 SQLite：把现有 db.json 一次性导入，之后不再全量重写
      if (fs.existsSync(DB_FILE)) {
        const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        db = Object.assign(emptyDb(), raw);
        normalizeLoaded();
        finishLoad();
        console.log('[db] 已把 ' + path.basename(DB_FILE) + ' 导入 SQLite：' + store.sqliteFile);
        return;
      }
      seedProblems();
      normalizeLoaded();
      finishLoad();
      saveDb(true);
      return;
    } catch (e) {
      console.error('[db] SQLite 加载失败，回退到 db.json:', e.message);
      db = emptyDb();
    }
  }

  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = Object.assign(emptyDb(), raw);
      normalizeLoaded();
      return;
    } catch (e) {
      console.error('[db] 读取失败，使用空库:', e.message);
      const broken = DB_FILE + '.broken-' + Date.now();
      try { fs.copyFileSync(DB_FILE, broken); } catch (_) {}
      db = emptyDb();
    }
  }
  seedProblems();
  normalizeLoaded();
  saveDb(true);
}

function writeDbFile() {
  // SQLite 引擎：只写变化的行；JSON 引擎：沿用全量原子写
  if (store.engine === 'sqlite') {
    store.save(db);
    return;
  }
  const tmp = DB_FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(db, null, 2), 'utf8');
    fs.fsyncSync(fd);          // 强杀/断电时不丢最近写入
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, DB_FILE);
  /* rename 只是把「目录项指向新文件」写进了内存中的 dentry；要让这次改名本身也落盘，
     还得 fsync 一次目录。少了这一步，极端断电后可能留下「tmp 里有完整新数据、db.json 还是旧名」
     的半完成状态。Windows 不允许 open 目录，会抛 EISDIR/EPERM，忽略即可（NTFS 语义不同）。 */
  try {
    const dfd = fs.openSync(path.dirname(DB_FILE), 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch (e) { /* 平台不支持目录 fsync */ }
}

function saveDb(immediate) {
  if (immediate) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    writeDbFile();
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeDbFile();
    } catch (e) {
      console.error('[db] 写入失败:', e.message);
    }
  }, TUNING.SAVE_DEBOUNCE_MS);
}

/* --------------------------------------------------- 浏览计数聚合
   GET /api/problems/:code 与帖子详情是最高频接口。原实现每次访问都 saveDb()：
   JSON 引擎会同步序列化整个库并 fsync，SQLite 引擎也会每次开一个写事务——
   这是典型的「读接口写放大」。现在只在内存里 +1，30 秒统一刷一次盘，
   进程退出/收到 SIGINT/SIGTERM 时强制刷一次，保证数据不丢。
   同一 (IP, 目标) 在 VIEW_DEDUPE_MS 内只计一次，防刷。 */
const pendingViews = new Map();
const viewSeen = new Map();
const VIEW_DEDUPE_MS = Number(process.env.VIEW_DEDUPE_MS || 60000);
const VIEW_SEEN_MAX = TUNING.VIEW_SEEN_MAX;

function bumpView(kind, id, ip) {
  const now = Date.now();
  const key = kind + ':' + id + '|' + ip;
  const last = viewSeen.get(key);
  if (last && now - last < VIEW_DEDUPE_MS) return false;
  viewSeen.set(key, now);
  if (viewSeen.size > VIEW_SEEN_MAX) {
    for (const [k, t] of viewSeen) if (now - t >= VIEW_DEDUPE_MS) viewSeen.delete(k);
    if (viewSeen.size > VIEW_SEEN_MAX) {
      let drop = viewSeen.size - VIEW_SEEN_MAX;
      for (const k of viewSeen.keys()) { if (drop-- <= 0) break; viewSeen.delete(k); }
    }
  }
  pendingViews.set(kind, (pendingViews.get(kind) || 0) + 1);
  return true;
}

function flushViews() {
  if (!pendingViews.size) return 0;
  const n = [...pendingViews.values()].reduce((a, b) => a + b, 0);
  pendingViews.clear();
  try {
    writeDbFile();
  } catch (e) {
    console.error('[views] 刷盘失败:', e.message);
    return 0;
  }
  return n;
}

setInterval(() => flushViews(), Number(process.env.VIEW_FLUSH_MS || 30000)).unref();

/* --------------------------------------------- 运行期备份 / 上线配置自检 */

const BACKUP_DIR = path.join(DATA_DIR, 'backups', 'daily');
const BACKUP_KEEP = Math.max(2, Number(process.env.BACKUP_KEEP || 14));
let lastBackupKey = '';

/* 进程长期运行时也要有备份：启动时快照只管「这一次启动」，
   线上跑一个月不重启的话，中间没有第二份可回滚的库。 */
function dailyBackup(force) {
  const key = new Date().toISOString().slice(0, 10);
  if (!force && key === lastBackupKey) return;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    if (store.engine === 'sqlite') {
      store.save(db);
      store.checkpoint();
      /* 优先 VACUUM INTO 做一致性热备；不支持时退回文件拷贝 */
      const snap = path.join(BACKUP_DIR, 'db-' + key + '.sqlite');
      if (typeof store.backupTo === 'function' && store.backupTo(snap)) {
        // 已写入快照
      } else {
        fs.copyFileSync(store.sqliteFile, snap);
      }
      if (store.mirror(db)) {
        try { fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, 'db-' + key + '.json')); } catch (_) {}
      }
    } else if (fs.existsSync(DB_FILE)) {
      fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, 'db-' + key + '.json'));
    } else {
      saveDb(true);
    }
    lastBackupKey = key;
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^db-\d{4}-\d{2}-\d{2}\./.test(f));
    const dates = [...new Set(files.map((f) => f.slice(3, 13)))].sort();
    while (dates.length > BACKUP_KEEP) {
      const drop = dates.shift();
      for (const f of files.filter((x) => x.slice(3, 13) === drop)) {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {}
      }
    }
    console.log('[backup] 已归档 ' + key + '（保留最近 ' + BACKUP_KEEP + ' 天）');
  } catch (e) {
    console.error('[backup] 定时备份失败:', e.message);
  }
}

/* 上线配置自检：这些项配错不会报错，但会静默降低安全性或让功能失效 */
function configWarnings() {
  const w = [];
  const prod = /^prod/i.test(String(process.env.NODE_ENV || '')) || String(process.env.NODE_ENV || '') === 'production';
  if (prod && ALLOWED_ORIGINS.includes('*')) {
    w.push('ALLOW_ORIGINS 仍是 *：任何站点都能带凭据调用接口，建议改成 https://hex1um.github.io 等白名单。');
  }
  if (prod && !TRUST_PROXY) {
    w.push('未设置 TRUST_PROXY=1：如果线上在反向代理后面，所有用户会共用代理 IP 的限流配额（登录 12 次/分、AI 40 次/10 分）。');
  }
  if (mailer.describe().mode === 'log') {
    w.push('邮件通道是日志模式：绑定邮箱的验证码只写服务端日志，需管理员手工转发。配置 SMTP_HOST 或 RESEND_API_KEY 即可自动切换。');
  }
  if (store.engine === 'json') {
    w.push('存储引擎为 JSON：每次保存都会全量序列化整个库，题目与用户继续增长后建议切 DB_ENGINE=sqlite。');
  }
  return w;
}

function configSummary() {
  const m = mailer.describe();
  return {
    version: VERSION,
    node: process.version,
    engine: store.engine,
    storage: store.stats(),
    trustProxy: TRUST_PROXY,
    allowOrigins: ALLOWED_ORIGINS,
    mail: { provider: m.provider, mode: m.mode, from: m.from },
    backup: { dir: BACKUP_DIR, keep: BACKUP_KEEP, last: lastBackupKey },
    llm: { siteKey: llmConfigured(), free: FREE_PROVIDERS.length },
    warnings: configWarnings()
  };
}

/* --------------------------------------------------- 运维应急通道
   场景：管理员忘了密码，而站点没有任何「找回密码」入口（没有邮箱闭环时也不该有）。
   做法：在部署目录放 data/ops/reset-admin.json，服务启动时消费一次、改完立即删除。
   能写部署目录的人本来就能控制这台机器，所以这不是新增的越权面；但没有 token 或
   文件格式不对时一律不动库，避免误放一个空文件就把密码改成空。 */
const OPS_DIR = process.env.OPS_DIR || path.join(DATA_DIR, 'ops');

async function applyOpsReset() {
  const file = path.join(OPS_DIR, 'reset-admin.json');
  if (!fs.existsSync(file)) return;
  try {
    const req = JSON.parse(fs.readFileSync(file, 'utf8'));
    const token = String(req.token || '').trim();
    const name = String(req.name || '').trim();
    const pw = String(req.password || '');
    if (token.length < 16) throw new Error('token 至少 16 位，用来确认这是有意为之而不是误放的文件');
    if (pw.length < 8) throw new Error('新密码至少 8 位');
    const u = db.users.find((x) => String(x.name || '').toLowerCase() === name.toLowerCase());
    if (!u) throw new Error('库里没有用户 ' + name);
    const hashed = await hashPassword(pw);
    u.salt = hashed.salt;
    u.passHash = hashed.hash;
    const wasAdmin = u.role === 'admin';
    if (!wasAdmin) u.role = 'admin';
    // 改密后旧会话必须失效，否则别人浏览器里的登录态仍然有效
    let killed = 0;
    for (const k of Object.keys(db.sessions)) {
      if (db.sessions[k] && db.sessions[k].uid === u.id) { delete db.sessions[k]; killed++; }
    }
    saveDb(true);
    fs.unlinkSync(file);
    console.log('[ops] 已重置 ' + u.name + ' 的密码' + (wasAdmin ? '' : '并授予管理员') + '，清理 ' + killed + ' 个旧会话，一次性文件已删除');
  } catch (e) {
    console.error('[ops] 重置失败，文件已改名留待人工处理：' + e.message);
    try { fs.renameSync(file, file + '.failed'); } catch (_) {}
  }
}

function seedProblems() {
  if (!fs.existsSync(SEED_FILE)) return;
  let list = [];
  try { list = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')); } catch (e) { return; }
  if (!Array.isArray(list)) return;
  const now = new Date().toISOString();
  for (const p of list) {
    const item = normalizeProblem(p);
    if (!item) continue;
    /* 种子题的编号也按学科走前缀：物理种子不该拿到 HS 编号 */
    item.code = nextProblemCode(item.subject);
    item.status = 'approved';
    item.authorName = p.authorName || '题库组';
    item.createdAt = p.createdAt || now;
    item.reviewedAt = now;
    item.solvedCount = 0;
    item.attemptCount = 0;
    db.problems.push(item);
  }
}

/* ------------------------------------------------------------- 业务逻辑 */

/* 题干摘要：按「文本 / 完整公式」原子切分后再截断。
   直接按字符 slice 会把 $...$ 切成两半，KaTeX 拿不到成对定界符，列表里就显示裸源码。 */
function excerptOf(statement, max) {
  const limit = max || 130;
  const t = String(statement || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 把 $$...$$ 与 $...$ 保护成原子块，块内不允许被截断
  const atoms = [];
  let rest = t;
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    if (m.index > 0) atoms.push({ text: rest.slice(0, m.index), math: false });
    const body = (m[1] || m[2] || '').trim();
    atoms.push({ text: '$' + body + '$', math: true });
    rest = rest.slice(m.index + m[0].length);
    re.lastIndex = 0;
  }
  if (rest) atoms.push({ text: rest, math: false });

  // 未闭合的 $ 之后的内容不再输出（否则列表里出现裸 $ 源码）
  // limit 是软限制：公式不可切开，允许整块越过；hardLimit 兜住极端长题干
  const hardLimit = limit * 2;
  const out = [];
  let len = 0;
  let truncated = false;
  for (const a of atoms) {
    let piece = a.text;
    if (!a.math) {
      const cut = piece.indexOf('$');
      if (cut >= 0) { piece = piece.slice(0, cut); truncated = true; }
      if (!piece) continue;
    }
    if (len + piece.length > hardLimit) { truncated = true; break; }
    if (a.math) {
      out.push(piece);
      len += piece.length;
      if (len >= limit) { truncated = true; break; }
      continue;
    }
    const room = limit - len;
    if (room <= 0) { truncated = true; break; }
    if (piece.length > room) {
      out.push(piece.slice(0, room));
      truncated = true;
      break;
    }
    out.push(piece);
    len += piece.length;
  }
  let result = out.join('').trim();
  if (truncated || result.length < t.length) result += '…';
  return result;
}

function visibleProblem(p, user) {
  const best = user && user.best ? user.best[p.code] : null;
  const subject = tagTax.subjectOf(p.subject);
  const out = {
    code: p.code,
    subject: subject,
    title: p.title,
    excerpt: excerptOf(p.statement),
    avgScore: p.scoreCount ? Math.round((p.scoreSum / p.scoreCount) * 10) / 10 : null,
    scoreCount: p.scoreCount || 0,
    myBest: best ? best.score : null,
    mainTag: p.mainTag || '综合',
    tags: p.tags,
    examTags: Array.isArray(p.examTags) ? p.examTags : [],
    kind: p.kind || '',
    thinking: p.thinking,
    difficulty: p.difficulty,
    calc: p.calc,
    level: levelOf(p.difficulty).name,
    levelColor: levelOf(p.difficulty).color,
    source: p.source,
    hintCount: (p.hints || []).length,
    solvedCount: p.solvedCount || 0,
    attemptCount: p.attemptCount || 0,
    createdAt: p.createdAt,
    solved: !!(user && user.solved && user.solved[p.code])
  };
  /* 列表页只需要「是不是计算题 / 有没有配图 / 有哪些思想标签」，
     完整 physicsMeta 留给详情接口，避免 6k+ 列表响应被元数据撑爆。 */
  if (subject === 'physics') {
    const meta = p.physicsMeta || {};
    out.physicsMeta = {
      answerType: meta.answerType || 'symbolic',
      unit: meta.unit || '',
      methods: Array.isArray(meta.methods) ? meta.methods : [],
      hasDiagram: !!(Array.isArray(meta.diagrams) && meta.diagrams.length),
      constants: Array.isArray(meta.constants) ? meta.constants.slice(0, 8) : []
    };
  }
  return out;
}

function fullProblem(p, user) {
  const base = visibleProblem(p, user);
  const solved = user && user.solved ? user.solved[p.code] : null;
  const out = Object.assign(base, {
    statement: p.statement,
    hints: p.hints || [],
    authorName: p.authorName || '题库组',
    xp: xpForProblem(p, solved),
    mySolve: solved || null
  });
  if (tagTax.subjectOf(p.subject) === 'physics') {
    /* refAnswer 是入库时留的排查字段（看答案有没有被 mathify 改坏），存在 physicsMeta 里。
       它绝不能直接下发：未登录访客 GET /api/problems/:code 就能读到标准答案，
       「先做题再看答案扣经验」的规则会被一行 curl 绕过去。
       只有本人已经交过卷或明确点过「看答案」时才回传，其余一律剥掉。 */
    const meta = Object.assign({}, p.physicsMeta || {});
    const rec = user && user.solved ? user.solved[p.code] : null;
    if (rec && (rec.revealed || rec.done || rec.judged)) {
      meta.refAnswer = p.answer || '';
    } else {
      delete meta.refAnswer;
    }
    out.physicsMeta = meta;
  }
  return out;
}


/* 标签聚合默认只统计数学（与 v2.6.0 的响应完全一致）；
   传 'physics' 时切到物理命名空间，传 'all' 时合并两边。 */
function allTags(subject) {
  const want = subject === 'all' ? 'all' : tagTax.subjectOf(subject || 'math');
  const map = new Map();
  for (const p of db.problems) {
    if (p.status !== 'approved') continue;
    if (want !== 'all' && tagTax.subjectOf(p.subject) !== want) continue;
    for (const t of p.tags) map.set(t, (map.get(t) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}

/* 主标签 → 子标签的树，给前端做两段式筛选。按学科取对应的主标签表，
   数学树里不会出现「电磁学」，物理树里也不会出现「级数」。 */
function tagTree(subject) {
  const key = tagTax.subjectOf(subject || 'math');
  const spec = tagTax.SUBJECTS[key];
  const mains = new Map(spec.mainTags.map((name) => [name, { name, count: 0, children: new Map() }]));
  for (const p of db.problems) {
    if (p.status !== 'approved') continue;
    if (tagTax.subjectOf(p.subject) !== key) continue;
    const node = mains.get(p.mainTag) || mains.get(spec.defaultMain);
    node.count++;
    for (const t of p.tags) node.children.set(t, (node.children.get(t) || 0) + 1);
  }
  return [...mains.values()]
    .filter((m) => m.count > 0)
    .map((m) => ({
      name: m.name,
      count: m.count,
      children: [...m.children.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count }))
    }));
}

/** 物理思想标签（守恒律 / 微元法 / 量纲分析…）聚合，供题库「按方法筛选」 */
function methodCounts(subject) {
  const key = tagTax.subjectOf(subject || 'physics');
  const map = new Map();
  for (const p of db.problems) {
    if (p.status !== 'approved' || tagTax.subjectOf(p.subject) !== key) continue;
    const methods = (p.physicsMeta && p.physicsMeta.methods) || [];
    for (const m of methods) map.set(m, (map.get(m) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}

/** 物理课程组的题量聚合，供筛选栏与学情页 */
function courseCounts(subject) {
  const key = tagTax.subjectOf(subject || 'physics');
  const out = {};
  for (const c of tagTax.coursesOf(key)) out[c.key] = { key: c.key, name: c.name, short: c.short, count: 0, mainTags: {} };
  for (const p of db.problems) {
    if (p.status !== 'approved' || tagTax.subjectOf(p.subject) !== key) continue;
    const ck = (p.physicsMeta && p.physicsMeta.course) || tagTax.courseOfMain(p.mainTag);
    const row = out[ck] || (out[ck] = { key: ck, name: ck, short: ck, count: 0, mainTags: {} });
    row.count++;
    row.mainTags[p.mainTag] = (row.mainTags[p.mainTag] || 0) + 1;
  }
  return Object.keys(out).map((k) => out[k]).sort((a, b) => b.count - a.count);
}

/** 每个学科的题量，给 meta/健康检查与前端页脚用 */
function subjectCounts() {
  const out = { math: 0, physics: 0 };
  for (const p of db.problems) {
    if (p.status !== 'approved') continue;
    out[tagTax.subjectOf(p.subject)]++;
  }
  return out;
}

function examTagCounts() {
  return EXAM_TAGS.map((name) => ({
    name,
    count: db.problems.filter((p) => p.status === 'approved' && (p.examTags || []).includes(name)).length
  })).filter((x) => x.count > 0);
}

function todayKey(d) {
  const dt = d || new Date();
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

/* 最近若干天出过的题。按学科取对应的键：数学沿用 'YYYY-MM-DD'，
   物理用 'p:YYYY-MM-DD'，两条连排互不干扰（每日一积 / 每日一物）。 */
function dailyKeyOf(dateKey, subject) {
  return tagTax.subjectOf(subject) === 'physics' ? 'p:' + dateKey : dateKey;
}

function recentCodes(days, subject) {
  const used = {};
  const now = new Date();
  const isPhys = tagTax.subjectOf(subject) === 'physics';
  for (let i = 1; i <= days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const code = db.daily[dailyKeyOf(todayKey(d), subject)];
    if (code) used[code] = true;
  }
  /* 物理题量少：顺手把数学日子里误指的物理题也排除掉，避免「今天一物 = 昨天一积」 */
  if (isPhys) {
    for (const k of Object.keys(db.daily)) {
      if (String(db.daily[k] || '').indexOf('PH') === 0) used[db.daily[k]] = true;
    }
  }
  return used;
}

/* 每日一积候选：积分主题 + 难度 ≥ 6（较难），题干/标签/标题任一命中积分即可。
   物理题不进「每日一积」：物理里也有「积分」，但那是求场/求功的手段，不是考点。 */
function isIntegralProblem(p) {
  if (tagTax.subjectOf(p.subject) !== 'math') return false;
  const hay = String(p.title || '') + ' ' + (p.tags || []).join(' ') + ' ' + String(p.statement || '');
  if (!/积分|定积分|不定积分|二重|三重|曲线积分|曲面积分|\\int|∫/.test(hay)) return false;
  return (p.difficulty || 0) >= 6;
}

function dailyProblem(dateKey, subject) {
  const key = dateKey || todayKey();
  const isPhys = tagTax.subjectOf(subject) === 'physics';
  const storeKey = dailyKeyOf(key, subject);
  const approved = db.problems.filter((p) => p.status === 'approved'
    && tagTax.subjectOf(p.subject) === (isPhys ? 'physics' : 'math'));
  if (!approved.length) return null;

  /* 物理走独立分支：没有「积分池」概念，也没有管理员连排表，
     只在物理题里按日期哈希取一道，并避开最近 30 天用过的题。 */
  if (isPhys) {
    const cached = db.daily[storeKey];
    const hit = cached ? approved.find((x) => x.code === cached) : null;
    if (hit) return hit;
    const used = recentCodes(30, 'physics');
    let pool = approved.filter((x) => !used[x.code]);
    if (!pool.length) pool = approved;
    const sorted = pool.slice().sort((a, b) => a.code.localeCompare(b.code));
    const p = sorted[strHash(key) % sorted.length];
    db.daily[storeKey] = p.code;
    saveDb();
    return p;
  }

  // 管理员可以手动指定某天的题（db.dailyOverride[key] = code）
  const forced = (db.dailyOverride || {})[key];
  if (forced) {
    const fp = db.problems.find((x) => x.code === forced);
    if (fp) return fp;
  }
  /* 连排表优先于「按日期哈希伪随机」，走完自动回落。
     排期按**题干指纹**认题，不写题号：题库重建一次 code 就重排一次，
     2026-11-27 那次重建把整批排期指向了别的题（出一道概率题当每日一积）。 */
  const pi = DAILY_PLAN.indexFor(key);
  if (pi >= 0) {
    const hit = DAILY_PLAN.resolve(db.problems, DAILY_PLAN.entries[pi]);
    const pp = hit.problem;
    if (pp) {
      if (hit.ambiguous > 1) {
        console.warn('[daily] ' + key + ' 的指纹命中 ' + hit.ambiguous + ' 道题，取 ' + pp.code);
      }
      if (db.daily[key] !== pp.code) {
        db.daily[key] = pp.code;
        saveDb();
      }
      return pp;
    }
    console.warn('[daily] 第 ' + (pi + 1) + ' 天的排期题在库里找不到（指纹失配），' + key + ' 回落到伪随机');
  }
  const code = db.daily[key];
  let p = code ? db.problems.find((x) => x.code === code && x.status === 'approved') : null;
  // 老缓存可能是改名前的非积分题：积分池够大就重挑
  if (p && !isIntegralProblem(p)) {
    const iP = approved.filter((x) => isIntegralProblem(x));
    if (iP.length >= 30) p = null;
  }
  if (!p) {
    // 最近 30 天出过的题不再选，题目不够时才放宽
    const used = recentCodes(30);
    // 优先在「较难的积分题」里挑，池子太小才退回全库
    const integral = approved.filter((x) => isIntegralProblem(x));
    let base = integral.length >= 30 ? integral : approved;
    let pool = base.filter((x) => !used[x.code]);
    if (!pool.length) pool = base;
    const sorted = pool.slice().sort((a, b) => a.code.localeCompare(b.code));
    p = sorted[strHash(key) % sorted.length];
    db.daily[key] = p.code;
    saveDb();
  }
  return p;
}

function pickProblemForDate(key) {
  const approved = db.problems.filter((p) => p.status === 'approved').slice().sort((a, b) => a.code.localeCompare(b.code));
  if (!approved.length) return null;
  return approved[strHash(key) % approved.length];
}

function recentDaily(days, user, subject) {
  const out = [];
  const isPhys = tagTax.subjectOf(subject) === 'physics';
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = todayKey(d);
    const storeKey = dailyKeyOf(key, subject);
    const cached = db.daily[storeKey];
    let p = cached ? db.problems.find((x) => x.code === cached && x.status === 'approved') : null;
    if (!p && isPhys) continue;
    if (!p || p.status !== 'approved') p = pickProblemForDate(key);
    if (p) {
      const rec = user && user.solved ? user.solved[p.code] : null;
      out.push({
        date: key, code: p.code, title: p.title, difficulty: p.difficulty,
        levelColor: levelOf(p.difficulty).color,
        solved: !!(rec && rec.done)
      });
    }
  }
  return out;
}

function logActivity(user, text, code) {
  if (!user) return;
  user.activity = user.activity || [];
  user.activity.unshift({ at: new Date().toISOString(), text, code: code || '' });
  user.activity = user.activity.slice(0, 40);
}

/* ------------------------------------------------------- 本地讲解兜底引擎 */

const TAG_STRATEGY = {
  '极限': ['先判断类型（0/0、∞/∞、1^∞、∞-∞），再决定等价无穷小、洛必达还是泰勒展开', '等价无穷小只在乘除结构里直接替换，加减结构要先合并', '指数型极限优先取对数，化成 0·∞ 再用洛必达'],
  '数列极限': ['先看单调有界定理能不能用', '递推数列先把不动点解出来，再研究偏差', '必要时用夹逼，找上下界是关键'],
  '等价无穷小': ['把式子整理成纯乘除再替换', '注意 1-cos x ~ x²/2、ln(1+x) ~ x、e^x-1 ~ x 的适用条件'],
  '洛必达': ['先确认是 0/0 或 ∞/∞，别对 0·∞ 直接上下求导', '求导后如果更乱，说明方向反了，换泰勒'],
  '泰勒展开': ['先定展开阶数：通常展开到不为零的最低阶', '常用 6 个展开式记牢，比洛必达稳'],
  '导数': ['先写清定义域，再谈可导', '分段点处用左右导数定义验证', '高阶导数考虑莱布尼茨公式或泰勒系数'],
  '中值定理': ['结论里有 f(ξ)=某式 → 构造辅助函数 F', '看到 f\'(ξ)+g\'(ξ)f(ξ) 想 e^{g(x)} 因子', '两个中值点要拆区间，用两次拉格朗日或用柯西'],
  '罗尔定理': ['验证三条件：闭区间连续、开区间可导、端点相等', '端点不相等就构造变号函数'],
  '不定积分': ['先看是不是基本积分表的变形', '有理函数先做部分分式分解', '根式换元要一次换干净，别忘了 dx'],
  '换元积分': ['换元三件套：设 t=、换 dx、换上下限', '三角换元用于 a²-x²、a²+x²、x²-a²'],
  '分部积分': ['按「反对幂指三」选 u', '出现循环积分时移项求解'],
  '定积分': ['先想对称性、周期性、区间再现公式', '含参数的定积分先看能不能求导（积分号下求导）'],
  '二重积分': ['画区域图，选直角坐标还是极坐标', '交换积分次序往往能救命'],
  '级数': ['先做通项极限的必要条件检查', '正项级数比较/比值/根值三选一', '交错级数看莱布尼茨条件'],
  '幂级数': ['先求收敛半径 R，再单独验端点', '求和函数用逐项求导/逐项积分凑已知展开式'],
  '微分方程': ['先判类型：可分离、一阶线性、齐次、伯努利', '一阶线性记住通解公式，别硬凑', '二阶常系数先写特征方程'],
  '不等式证明': ['把不等式移项构造函数，求导看单调性', '端点值 + 单调性往往就够', '复杂不等式先证中间量'],
  '函数性质': ['先看奇偶性、周期性、单调性再动手', '极值点用一阶导变号判断'],
  '连续': ['分段点连续看左右极限是否相等', '间断点分类：可去、跳跃、无穷、振荡'],
  '无穷小比较': ['做比值的极限，看阶数', '同阶不等价时要用泰勒对齐']
};

/* 九主标签维度的做题汇总：薄弱考点定向推题、学科雷达都用它 */
function mainTagAgg(user) {
  const solved = (user && user.solved) || {};
  const best = (user && user.best) || {};
  const agg = new Map(tagTax.MAIN_TAGS.map((t) => [t, { tag: t, attempts: 0, passed: 0, scoreSum: 0 }]));
  const byCode = new Map(db.problems.map((p) => [p.code, p]));
  for (const [code, rec] of Object.entries(solved)) {
    const p = byCode.get(code);
    if (!p) continue;
    const o = agg.get(p.mainTag || '综合');
    if (!o) continue;
    const sc = (best[code] && best[code].score) || (rec.done ? 100 : 0);
    o.attempts++;
    if (rec.done) o.passed++;
    o.scoreSum += sc;
  }
  return [...agg.values()].map((o) => ({
    tag: o.tag,
    attempts: o.attempts,
    passed: o.passed,
    rate: o.attempts ? Math.round((o.passed / o.attempts) * 100) : 0,
    avgScore: o.attempts ? Math.round(o.scoreSum / o.attempts) : 0
  }));
}

/* 薄弱主标签：做过但没全对，按通过率、均分从低到高取前 N 个 */
function weakMainTags(user, limit) {
  return mainTagAgg(user)
    .filter((t) => t.attempts > 0 && t.passed < t.attempts)
    .sort((a, b) => a.rate - b.rate || a.avgScore - b.avgScore || b.attempts - a.attempts)
    .slice(0, limit || 3)
    .map((t) => t.tag);
}

function strategyFor(tags) {
  const out = [];
  for (const t of tags || []) {
    const key = Object.keys(TAG_STRATEGY).find((k) => t.includes(k) || k.includes(t));
    if (key) for (const s of TAG_STRATEGY[key]) if (!out.includes(s)) out.push(s);
  }
  if (!out.length) out.push('先把题目里的条件和要求逐条翻译成数学语言，再决定用哪个工具');
  return out.slice(0, 4);
}

function localTutorText(problem, question) {
  const q = String(question || '').trim();
  const lines = [];

  if (!problem) {
    const topics = Object.keys(TAG_STRATEGY).filter((k) => q.includes(k));
    lines.push('### 我的理解');
    lines.push('你把问题描述给我，我按高数的通用套路帮你拆。');
    if (topics.length) {
      lines.push('');
      lines.push('### 你问到的方向');
      for (const t of topics.slice(0, 3)) {
        lines.push('**' + t + '**');
        for (const s of TAG_STRATEGY[t].slice(0, 2)) lines.push('- ' + s);
      }
    } else {
      lines.push('');
      lines.push('### 建议的信息');
      lines.push('1. 完整题干（用 `$...$` 包住公式）');
      lines.push('2. 你已经做到哪一步、卡在哪里');
      lines.push('3. 是在求极限、求导、积分还是证明');
    }
    lines.push('');
    lines.push('> 提示：从题库里点进某道题再问我，我会带着这道题的题干、考点和提示来回答。');
    return lines.join('\n');
  }

  const tags = problem.tags || [];
  lines.push('### 考点定位');
  lines.push('这道题的核心是 **' + tags.join(' / ') + '**。' + (problem.difficulty >= 8 ? '难度偏高，属于综合型，先别急着算，先把结构看清楚。' : '属于常规题型，套路是固定的。'));
  lines.push('');
  lines.push('### 思路骨架');
  const strat = strategyFor(tags);
  strat.forEach((s, i) => lines.push((i + 1) + '. ' + s));

  if (problem.hints && problem.hints.length) {
    lines.push('');
    lines.push('### 分层提示');
    problem.hints.slice(0, q.includes('提示') || q.includes('卡') ? 2 : 1).forEach((h, i) => {
      lines.push('**提示 ' + (i + 1) + '**：' + h);
    });
  }

  if (/为什么|怎么想到|思路|看不懂|没思路|不会/.test(q)) {
    lines.push('');
    lines.push('### 为什么会想到这一步');
    lines.push('看到「' + tags[0] + '」这个信号，第一反应应该是找对应的标准工具：' + strat[0] + '。这类题目的命题点通常就藏在条件的形式里，把条件改写成标准形式，路子就出来了。');
  }

  if (problem.solution) {
    lines.push('');
    lines.push('### 完整解答（先自己写一遍再看）');
    lines.push(problem.solution);
  } else if (problem.answer) {
    lines.push('');
    lines.push('### 参考答案');
    lines.push(problem.answer);
  }

  lines.push('');
  lines.push('### 易错点');
  lines.push('- 别跳过定义域和适用条件');
  lines.push('- 计算出结果后代回原式验算一次，特别是符号和常数');
  lines.push('');
  lines.push('> 如果你告诉我你卡在第几步，我可以只讲那一步，不直接给答案。');
  return lines.join('\n');
}

/* ------------------------------------------------------- AI 通道层装配
   LLM 提示词、通道候选、地址白名单与降级逻辑都在 lib/ai.js（P2-1 Step 2）。
   这里只做依赖注入：db 用 getter 传，避免启动时被重新赋值后拿到旧对象。 */
const ai = require('./ai')({
  getDb: () => db,
  tagTax: tagTax,
  saveDb: saveDb,
  normalizeProblem: normalizeProblem,
  onStatsChange: () => pendingViews.set('aiStats', 1),
  constants: { DIFF_MAX: DIFF_MAX, EXAM_TAGS: EXAM_TAGS },
  log: (...args) => console.error(...args)
});
const {
  FREE_PROVIDERS, RESPONSE_GUARD, OCR_PROMPT, EXPERT_SYSTEM,
  llmConfigured, retrieveSimilar, llmMessages, buildGenerateMessages,
  normalizeSectionMarks, parseTaggedInline, parseGenerated, repairJsonText, extractJson,
  validateGenerated, validateFromImage, stripTitleNumber, metaSystem, parseMetaText,
  completeProblemMeta, safeLlmBaseUrl, userLlmConfig, llmCandidates,
  aiStats, noteAi, openChat, callLLM, streamLLM
} = ai;

/* 熔断快照：给健康检查与管理员面板看每个通道是闭合还是熔断中 */
const aiBreakers = () => (typeof ai.aiBreakers === 'function' ? ai.aiBreakers() : {});

/* --------------------------------------------------------- 答疑区 AI 回帖 */

async function generateForumReply(post, problem, ask) {
  const sys = {
    role: 'system',
    content: '你是「数海晴岸」答疑区的 AI 助教。回答要短（150-300 字）、直接、有可执行的第一步，公式用 $...$。'
      + '不要空泛鼓励，不要重复帖子里已有的内容。如果帖子信息不足，就指出还缺什么。'
      + (ask ? '这次是有人专门 @ 你追问，要针对他那句话回答，指出其中对/错在哪。' : '')
  };
  const parts = ['## 帖子：' + post.title, post.body];
  if (ask) parts.push('## 有人 @ 你追问：' + ask);
  if (problem) {
    parts.push('## 关联题目 ' + problem.code + '：' + problem.title);
    parts.push('题干：' + problem.statement);
    parts.push('考点：' + (problem.tags || []).join('、'));
    if (problem.hints && problem.hints.length) parts.push('题库提示：' + problem.hints.join(' ｜ '));
    if (problem.solution) parts.push('标准解答：' + problem.solution);
  }
  const userMsg = { role: 'user', content: parts.join('\n\n') };

  for (const cfg of llmCandidates(null)) {
    try {
      const text = await callLLM(cfg, [sys, userMsg]);
      if (text && text.trim()) return text.trim();
    } catch (e) {
      console.error('[forum-ai] ' + cfg.name + ' 失败:', e.message);
    }
  }

  // 本地兜底
  const tags = problem ? problem.tags : [];
  const strat = strategyFor(tags);
  const out = [];
  out.push('**先定方向**：' + (tags.length ? '这题属于 ' + tags.slice(0, 2).join(' / ') + ' 型，' : '') + '建议第一步：' + strat[0] + '。');
  if (problem && problem.hints && problem.hints.length) {
    out.push('');
    out.push('**可以先用这条提示**：' + problem.hints[0]);
  }
  out.push('');
  out.push('**如果你已经动手了**，把算到的那一步贴出来（用 $...$ 写公式），我可以只看那一步帮你纠错，不剧透后面的。');
  return out.join('\n');
}

function scheduleForumReply(postId, opts) {
  const ask = opts && opts.ask ? String(opts.ask).slice(0, 1000) : '';
  const afterReplyId = opts && opts.afterReplyId ? opts.afterReplyId : null;
  setTimeout(async () => {
    const post = db.posts.find((p) => p.id === postId);
    if (!post) return;
    // 发帖时的首答：已经有一个 AI 回答就不再重复；被 @ 追问时要另外答一条
    if (!ask && post.replies.some((r) => r.isAI)) return;
    const problem = post.problemCode ? db.problems.find((p) => p.code === post.problemCode) : null;
    let body = '';
    try {
      body = await generateForumReply(post, problem, ask);
    } catch (e) {
      body = '**AI 助教暂时没连上**，先把题目条件拆成「已知 / 要求」，再贴一下你卡住的步骤。';
    }
    const target = db.posts.find((p) => p.id === postId);
    if (!target) return;
    target.replies.push({
      id: db.meta.replySeq++,
      authorId: null,
      authorName: 'AI 助教',
      isAI: true,
      replyTo: afterReplyId,
      body,
      createdAt: new Date().toISOString()
    });
    saveDb();
  }, 900);
}

/* --------------------------------------------------- 发帖配额 / 邮箱绑定
   未绑定邮箱的账号：每小时只能发 1 条帖子、1 条回复。
   绑定了邮箱（验证码通过）就没有这个限制。管理员不受限。 */
const HOUR = 60 * 60 * 1000;

function recentCount(list, uid, since) {
  return list.filter((x) => x.uid === uid && x.at >= since).length;
}

function postQuota(user, isReply) {
  if (!user) return { blocked: true, message: '请先登录' };
  if (user.role === 'admin') return { blocked: false };
  if (user.emailVerified) return { blocked: false };
  const log = user.quotaLog || { posts: [], replies: [] };
  const since = Date.now() - HOUR;
  const n = recentCount(isReply ? log.replies : log.posts, user.id, since);
  if (n >= 1) {
    return {
      blocked: true,
      message: (isReply ? '回复' : '发帖') + '配额已用完（未绑定邮箱每小时 1 条）。绑定邮箱后可解除限制。'
    };
  }
  return { blocked: false };
}

function noteQuota(user, isReply) {
  if (!user || user.role === 'admin' || user.emailVerified) return;
  user.quotaLog = user.quotaLog || { posts: [], replies: [] };
  const bucket = isReply ? user.quotaLog.replies : user.quotaLog.posts;
  bucket.push({ uid: user.id, at: Date.now() });
  // 只留最近两小时的记录，避免无限增长
  const cut = Date.now() - 2 * HOUR;
  user.quotaLog.posts = user.quotaLog.posts.filter((x) => x.at >= cut);
  user.quotaLog.replies = user.quotaLog.replies.filter((x) => x.at >= cut);
}

/* 邮箱验证码：本地库存储，5 分钟有效。
   通道由 lib/mail.js 决定：配了 SMTP / Resend 就真发信，没配就只写服务端日志。
   验证码永远不随 HTTP 响应回显（否则任何人注册后都能绑任意假邮箱、绕过发帖限流）。 */
function genCode() {
  return String(crypto.randomInt(100000, 1000000));
}

async function sendMailCode(email, code) {
  const subject = '数海晴岸 · 邮箱验证码';
  const text = [
    '你的邮箱验证码是：' + code,
    '',
    '5 分钟内有效。绑定后可以解除发帖/回复的每小时限制：发帖 1 条、回复 1 条。',
    '如果这不是你本人的操作，忽略本邮件即可。'
  ].join('\n');
  const r = await mailer.send({ to: email, subject, text });
  if (!r.delivered) {
    console.log('[mail] 验证码 ' + code + ' -> ' + email + '（' + (r.provider === 'log' ? '未接入邮件服务，仅管理员可见' : '发送失败: ' + (r.error || '未知原因')) + '）');
  }
  return r;
}

const FEEDBACK_TYPES = {
  appeal: '判分申诉',
  wrong_answer: '答案/解析有误',
  wrong_statement: '题干有误或不完整',
  score: '三维评分不合理',
  tags: '标签不准确',
  other: '其他问题'
};

/* AI 审阅反馈：判断有效性、归类、给管理员一句摘要。
   输出用 [SECTION] 分段（避开 JSON 里 LaTeX 反斜杠被吃掉的老坑）。 */
async function generateFeedbackReview(problem, feedback) {
  const typeName = FEEDBACK_TYPES[feedback.type] || '其他问题';
  const sys = {
    role: 'system',
    content: [
      '你是数海晴岸题库的审题助理。用户提交了一条对题目的反馈，你要先替管理员审阅一遍。',
      '步骤：1) 判断这条反馈是否有实质内容（有没有指出具体问题）；2) 归类；3) 用一句话给管理员摘要；4) 给一条处理建议。',
      '输出严格用下面分段格式，不要 JSON、不要代码块、不要多余解释：',
      '[VALID]', 'yes 或 no',
      '[CATEGORY]', '一个词：答案错误 / 题干错误 / 评分不当 / 标签不当 / 有效建议 / 无效反馈',
      '[SUMMARY]', '一句话（≤60字），说清用户指出了什么问题',
      '[ADVICE]', '一句话（≤80字），给管理员的处理建议',
      '',
      '注意：你只审阅反馈本身，不要重新解这道题，不要因为自己算的结果和用户不同而直接否定用户；',
      '遇到你也不确定的数学结论，VALID 仍填 yes，并在 ADVICE 里写「建议人工复核」。'
    ].join('\n')
  };
  const parts = [
    '## 题目 ' + problem.code + '：' + problem.title,
    '题干：' + String(problem.statement || '').slice(0, 600),
    '题库答案：' + String(problem.answer || '').slice(0, 300),
    '用户反馈类型：' + typeName,
    '用户反馈内容：' + feedback.content
  ];
  if (feedback.imageDesc) parts.push('用户附图说明：' + feedback.imageDesc);
  const userMsg = { role: 'user', content: parts.join('\n\n') };

  const candidates = llmCandidates(null);
  for (const cfg of candidates) {
    try {
      const text = await callLLM(cfg, [sys, userMsg]);
      const parsed = parseFeedbackReview(text);
      if (parsed) return Object.assign(parsed, { model: cfg.name, reviewedAt: new Date().toISOString() });
    } catch (e) {
      console.error('[feedback-ai] ' + cfg.name + ' 失败:', e.message);
    }
  }
  // 本地兜底：保证反馈仍能转给管理员，只是标注为未做 AI 审阅
  return {
    valid: 'unknown', category: '待人工复核',
    summary: String(feedback.content || '').replace(/\s+/g, ' ').slice(0, 80),
    advice: 'AI 通道不可用，请管理员直接阅读原文判断。',
    model: '本地兜底', reviewedAt: new Date().toISOString()
  };
}

function parseFeedbackReview(text) {
  const s = String(text || '');
  const pick = (name, next) => {
    const re = new RegExp('\\[' + name + '\\]\\s*([\\s\\S]*?)(?=\\[' + next + '\\]|$)');
    const m = s.match(re);
    return m ? m[1].trim() : '';
  };
  const validRaw = pick('VALID', 'CATEGORY').toLowerCase();
  const valid = /^(yes|true|1|是|有效)/.test(validRaw) ? 'yes' : (/^(no|false|0|否|无效)/.test(validRaw) ? 'no' : 'unknown');
  const category = pick('CATEGORY', 'SUMMARY').slice(0, 40);
  const summary = pick('SUMMARY', 'ADVICE').slice(0, 240);
  const advice = pick('ADVICE', 'END').slice(0, 300);
  if (!summary && !category) return null;
  return { valid, category, summary, advice };
}

function scheduleFeedbackReview(feedbackId) {
  setTimeout(async () => {
    const fb = db.feedbacks.find((f) => f.id === feedbackId);
    if (!fb || fb.ai && fb.ai.reviewedAt) return;
    const problem = db.problems.find((p) => p.code === fb.code);
    if (!problem) return;
    let review;
    try {
      review = await generateFeedbackReview(problem, fb);
    } catch (e) {
      review = { valid: 'unknown', category: '待人工复核', summary: fb.content.slice(0, 80), advice: 'AI 审阅异常，请人工判断。', model: '异常兜底', reviewedAt: new Date().toISOString() };
    }
    const target = db.feedbacks.find((f) => f.id === feedbackId);
    if (!target) return;
    target.ai = review;
    saveDb();
  }, 700);
}

function publicFeedback(f, user) {
  return {
    id: f.id, code: f.code, type: f.type, typeName: FEEDBACK_TYPES[f.type] || '其他问题',
    content: f.content, createdAt: f.createdAt,
    ai: f.ai || null,
    status: f.status || 'open',
    /* 判分申诉要带提交号，前端才能按 submissionId 改分 */
    submissionId: f.submissionId || '',
    submissionScore: f.submissionScore,
    submissionAt: f.submissionAt || '',
    isMine: !!(user && f.userId === user.id),
    problemDeleted: !!f.problemDeleted
  };
}

/* --------------------------------------------------------------- 路由表 */

const RATE_RULES = [
  [/^\/api\/auth\/(login|register)$/, 12, 60 * 1000, '登录/注册太频繁，等一分钟再试'],
  [/^\/api\/auth\/password$/, 6, 60 * 1000, '改密太频繁，等一分钟再试'],
  [/^\/api\/ai\/chat$/, 40, 10 * 60 * 1000, '今天的提问有点多，歇一会儿再来'],
  [/^\/api\/submit$/, 20, 10 * 60 * 1000, '投稿太频繁了，先等等'],
  [/^\/api\/forum$/, 30, 10 * 60 * 1000, '发帖太频繁了，先等等'],
  [/^\/api\/problems\/[^/]+\/feedback$/, 12, 10 * 60 * 1000, '反馈提交太频繁了，先等等'],
  [/^\/api\/ai\/ocr-fix$/, 30, 10 * 60 * 1000, 'OCR 规范化请求太多，先等等'],
  [/^\/api\/ai\/generate$/, 12, 60 * 60 * 1000, 'AI 出题每小时最多 12 次'],
  // 站点共享的视觉 Key 是全站共用一个额度，必须限流，否则一个人就能刷爆
  [/^\/api\/ai\/from-image$/, 30, 60 * 60 * 1000, '识图太频繁了：每小时最多 30 次，先用本地 OCR 或稍后再试'],
  // 发验证码会真的发信（配额与费用都在我们这边），必须限流，否则能拿来刷别人邮箱
  [/^\/api\/me\/email\/send$/, 6, 60 * 60 * 1000, '验证码发得太频繁了：每小时最多 6 次，稍后再试'],
  [/\/answer$/, 40, 60 * 60 * 1000, '判题刷得太快了，歇一会儿']
];

/* 支持图片的判卷模型名单。必须在 handleApi 之外定义：
   判卷接口（图片分支）在函数内较早处就调用它，若用函数内的 const 声明会出现 TDZ
   「Cannot access 'VISION_MODEL' before initialization」。 */
const VISION_MODEL = /gpt-4o|gpt-4\.1|o3|o4|claude|gemini|qwen.*vl|glm-4v|vision|llava|internvl/i;



/* 上传落盘：只认 PNG/JPEG/WebP，落盘前校验文件头（防伪装 SVG/HTML） */
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

/* 只认文件头，不认前端声明的 Content-Type / 扩展名：
   伪装成 .png 的 HTML 或 SVG 一旦同源打开就是 XSS（SVG 内可执行脚本）。 */
function detectSafeImageExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null; // 显式拒绝 SVG / GIF / HTML 等高风险格式
}

function saveUpload(dataUrl) {
  try {
    const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(dataUrl);
    if (!m) return '';
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 4 * 1024 * 1024) return '';
    const ext = detectSafeImageExt(buf);
    if (!ext) {
      console.warn('[upload] 拒绝非 PNG/JPEG/WebP 的文件内容');
      return '';
    }
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const name = Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + '.' + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    return '/uploads/' + name;
  } catch (e) {
    console.error('[upload] 保存失败:', e.message);
    return '';
  }
}

/* 发帖/回帖最多带 3 张图，逐张落盘后返回 URL 列表 */
function saveUploads(body) {
  const raw = Array.isArray(body.images) ? body.images : (body.image ? [body.image] : []);
  return raw
    .filter((s) => typeof s === 'string' && s.indexOf('data:image/') === 0)
    .slice(0, 3)
    .map(saveUpload)
    .filter(Boolean);
}
  return {
    // 数据层
    get db() { return db; },
    store,
    tagTax,
    fsrs,
    mailer,
    limiter,
    rateLimit,
    emptyDb, ensureDirs, snapshotDb, normalizeLoaded, finishLoad, restoreFromBackup,
    loadDb, writeDbFile, saveDb, seedProblems, dailyBackup, configWarnings, configSummary,
    applyOpsReset, flushViews, bumpView,
    // 常量 / 配置
    ALLOWED_ORIGINS, TRUST_PROXY, RATE_RULES, VISION_MODEL,
    EXAM_TAGS, SITE_NAME, VERSION, DATA_DIR, DB_FILE, SEED_FILE, ROOT, PUBLIC_DIR, UPLOAD_DIR,
    FEEDBACK_TYPES, TAG_STRATEGY, HOUR,
    /* 四个按域拆出的模块（lib/auth.js / problem-normalize.js / judge.js / gamify.js）
       在这里展开成同一张能力表：路由层看到的 ctx.services.* 与拆分前完全一致。 */
    ...gamify,          // LEVELS / DIFF_MAX / levelOf / clampScore / levelInfo / xpForProblem
    ...problemTools,    // mathify / qualityGate / dedupeCanon / normalizeProblem / nextProblemCode …
    ...authTools,       // hashPassword / session* / currentUser / publicUser
    ...judge,           // canonAnswer / judgeMessages / parseJudge / physicsJudge* …
    excerptOf, visibleProblem, fullProblem, allTags, tagTree, examTagCounts,
    methodCounts, subjectCounts, courseCounts,
    todayKey, strHash, recentCodes, isIntegralProblem, dailyProblem, pickProblemForDate,
    recentDaily, logActivity,
    // 学习分析
    mainTagAgg, weakMainTags, strategyFor, localTutorText,
    // AI
    ai, FREE_PROVIDERS, RESPONSE_GUARD, OCR_PROMPT, EXPERT_SYSTEM,
    llmConfigured, retrieveSimilar, llmMessages, buildGenerateMessages,
    normalizeSectionMarks, parseTaggedInline, parseGenerated, repairJsonText, extractJson,
    validateGenerated, validateFromImage, stripTitleNumber, metaSystem, parseMetaText,
    completeProblemMeta, safeLlmBaseUrl, userLlmConfig, llmCandidates,
    aiStats, aiBreakers, noteAi, openChat, callLLM, streamLLM,
    // 答疑 / 反馈 / 邮件
    generateForumReply, scheduleForumReply, recentCount, postQuota, noteQuota,
    genCode, sendMailCode, generateFeedbackReview, parseFeedbackReview,
    scheduleFeedbackReview, publicFeedback,
    // 上传
    saveUpload, saveUploads
  };
};
