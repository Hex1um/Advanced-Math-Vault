/**
 * Advanced-Math-Vault · 零依赖后端
 * 单进程 Node HTTP 服务：账号 / 题库 / 审核 / 答疑区 / 每日一题 / 经验 / LLM 代理
 * 数据落盘：data/db.json（原子写），首次启动自动导入 data/problems.seed.json
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'db.json');
const SEED_FILE = process.env.SEED_FILE || path.join(DATA_DIR, 'problems.seed.json');
const PORT = Number(process.env.PORT || 8787);
const SITE_NAME = process.env.SITE_NAME || 'Advanced-Math-Vault';
const HOST = process.env.HOST || '0.0.0.0';

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

function loadDb() {
  ensureDirs();
  snapshotDb();
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = Object.assign(emptyDb(), raw);
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
        if (!Array.isArray(p.tags)) p.tags = ['未分类'];
        if (p.tags.length > 3) p.tags = p.tags.slice(0, 3);
        if (p.difficulty > DIFF_MAX) p.difficulty = DIFF_MAX;
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
      return;
    } catch (e) {
      console.error('[db] 读取失败，使用空库:', e.message);
      const broken = DB_FILE + '.broken-' + Date.now();
      try { fs.copyFileSync(DB_FILE, broken); } catch (_) {}
    }
  }
  seedProblems();
  saveDb(true);
}

function writeDbFile() {
  const tmp = DB_FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(db, null, 2), 'utf8');
    fs.fsyncSync(fd);          // 强杀/断电时不丢最近写入
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, DB_FILE);
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
  }, 400);
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
    item.code = 'HS' + db.meta.seq++;
    item.status = 'approved';
    item.authorName = p.authorName || '题库组';
    item.createdAt = p.createdAt || now;
    item.reviewedAt = now;
    item.solvedCount = 0;
    item.attemptCount = 0;
    db.problems.push(item);
  }
}

/* ------------------------------------------------------------- 工具函数 */

const LEVELS = [
  { max: 3, name: '基础巩固', color: '#4ade80' },
  { max: 5, name: '常规练习', color: '#38bdf8' },
  { max: 7, name: '综合提高', color: '#fbbf24' },
  { max: 8, name: '考研冲刺', color: '#fb923c' },
  { max: 9, name: '竞赛入门', color: '#f87171' },
  { max: 10, name: '竞赛压轴', color: '#c084fc' }
];

function levelOf(d) {
  const n = Math.max(1, Math.min(10, Number(d) || 5));
  for (const l of LEVELS) if (n <= l.max) return l;
  return LEVELS[LEVELS.length - 1];
}

function clampScore(v, fallback, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max || 10, n));
}

const DIFF_MAX = 15;

/* 公式定界符整理：模型经常混用 $$...$$ / \[...\] / \(...\)，还可能干脆不写 */
function mathify(src) {
  let t = String(src || '');
  if (!t) return t;

  // 1) 先处理已经成对的 $...$ / $$...$$，把里面多套的一层 \[ \] \( \) 剥掉
  t = t.replace(/(\${1,2})([\s\S]*?)\1/g, function (m, mark, body) {
    let b = body.trim();
    b = b.replace(/^\\\[/, '').replace(/\\\]$/, '');
    b = b.replace(/^\\\(/, '').replace(/\\\)$/, '');
    return mark + b.trim() + mark;
  });

  // 2) 剩下裸露的 \[...\] / \(...\) 直接换成长定界符
  t = t.replace(/\\\[([\s\S]*?)\\\]/g, function (m, body) { return '$$' + body.trim() + '$$'; });
  t = t.replace(/\\\(([\s\S]*?)\\\)/g, function (m, body) { return '$' + body.trim() + '$'; });

  // 3) 完全没有 $ 的，把含 LaTeX 命令的 ASCII 片段整体包起来
  if (t.indexOf('$') < 0) {
    t = t.replace(/[\t\x20-\x7E]{3,}/g, function (run) {
      if (!/\\[a-zA-Z]|[\^_]/.test(run)) return run;
      const lead = (run.match(/^\s+/) || [''])[0];
      const trail = (run.match(/\s+$/) || [''])[0];
      const core = run.trim().replace(/\t/g, ' ');
      if (core.length < 3) return run;
      const open = (core.match(/\{/g) || []).length;
      const close = (core.match(/\}/g) || []).length;
      if (open !== close) return run;
      const display = /\\int|\\iint|\\iiint|\\sum|\\prod|\\lim/.test(core);
      const mark = display ? '$$' : '$';
      return lead + mark + core + mark + trail;
    });
  }
  return t;
}

/* 入库质量门禁：不拦人，但把可疑点在题目上打标，审核后台显示警示 */
function qualityGate(item, existing) {
  const warns = [];
  const st = String(item.statement || '');
  if (((st.match(/\$/g) || []).length) % 2) warns.push('定界符不配对（$ 个数为奇数）');
  const bare = st.replace(/\$\$[\s\S]*?\$\$/g, '').replace(/\$[^$]*\$/g, '');
  if (/\\[a-zA-Z]{2,}/.test(bare)) warns.push('正文含未包 $ 的 LaTeX 命令');
  if (/答\s*案\s*[：:]|解\s*[：:]/.test(st)) warns.push('题干疑似含答案/解答');
  if (/\\begin\{tasks\}|\\begin\{tabular\}|<table/i.test(st)) warns.push('残留题目环境或 HTML 表格');
  if (/\$\$\$\$/.test(st)) warns.push('连续四个 $');
  const tl = String(item.title || '');
  if (Array.isArray(existing) && tl && existing.some((x) => x.title === tl && x.code !== item.code)) {
    warns.push('标题与库内已有题目重复');
  }
  return warns;
}

function normalizeProblem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim();
  const statement = String(raw.statement || raw.body || '').trim();
  if (!title || !statement) return null;
  let tags = raw.tags;
  if (typeof tags === 'string') tags = tags.split(/[,，、\s]+/);
  tags = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 3) : [];
  let hints = raw.hints;
  if (typeof hints === 'string') hints = [hints];
  hints = Array.isArray(hints) ? hints.map((h) => String(h).trim()).filter(Boolean).slice(0, 5) : [];
  const itemOut = {
    code: '',
    title: title.slice(0, 120),
    statement: mathify(statement),
    tags: tags.length ? tags : ['未分类'],
    thinking: clampScore(raw.thinking, 6),
    difficulty: clampScore(raw.difficulty, 6, DIFF_MAX),
    calc: clampScore(raw.calc !== undefined ? raw.calc : raw.calculation, 5),
    source: String(raw.source || '').slice(0, 80),
    hints: hints.map(mathify),
    answer: mathify(String(raw.answer || '').trim()),
    solution: mathify(String(raw.solution || '').trim()),
    status: 'pending',
    authorId: null,
    authorName: '',
    rejectReason: '',
    createdAt: new Date().toISOString(),
    reviewedAt: null,
    solvedCount: 0,
    attemptCount: 0,
    scoreSum: 0,
    scoreCount: 0
  };
  const warns = qualityGate(itemOut, db.problems);
  if (warns.length) itemOut.qualityWarn = warns;
  return itemOut;
}

function nextProblemCode() {
  let code;
  do { code = 'HS' + db.meta.seq++; } while (db.problems.some((p) => p.code === code));
  return code;
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(password), s, 64).toString('hex');
  return { salt: s, hash: h };
}

function verifyPassword(password, user) {
  try {
    const h = crypto.scryptSync(String(password), user.salt, 64);
    const stored = Buffer.from(user.passHash, 'hex');
    return h.length === stored.length && crypto.timingSafeEqual(h, stored);
  } catch (e) { return false; }
}

function levelInfo(exp) {
  const e = Math.max(0, exp || 0);
  const level = Math.floor(Math.sqrt(e / 25)) + 1;
  const cur = Math.pow(level - 1, 2) * 25;
  const next = Math.pow(level, 2) * 25;
  return { level, exp: e, cur, next, progress: Math.min(1, (e - cur) / Math.max(1, next - cur)) };
}

function publicUser(u, withPrivate) {
  if (!u) return null;
  const li = levelInfo(u.exp);
  const solvedMap = u.solved || {};
  // 只统计真正做出来的（≥80 分），做过但没过的单独给 attempts
  const doneCount = Object.keys(solvedMap).filter((k) => solvedMap[k] && solvedMap[k].done).length;
  const out = {
    id: u.id, name: u.name, role: u.role || 'user',
    exp: u.exp || 0, level: li.level, levelProgress: li.progress,
    solvedCount: doneCount,
    attempts: u.attempts || 0,
    createdAt: u.createdAt
  };
  // 邮箱只给本人和后台看；排行榜/公共列表默认不带
  if (withPrivate) {
    out.email = u.email || '';
    out.emailVerified = !!u.emailVerified;
  }
  return out;
}

function readBody(req, limit) {
  limit = limit || 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch (e) {
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  });
  return out;
}

const ALLOWED_ORIGINS = String(process.env.ALLOW_ORIGINS || '*').split(',').map((x) => x.trim()).filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  let allow = '';
  if (ALLOWED_ORIGINS.includes('*')) allow = '*';
  else if (origin && ALLOWED_ORIGINS.includes(origin)) allow = origin;
  if (allow) {
    res.setHeader('Access-Control-Allow-Origin', allow);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-MV-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function bearerToken(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+([A-Za-z0-9]+)$/.exec(h);
  if (m) return m[1];
  // 有些托管网关会吃掉 Authorization 头，这里再认一个自定义头
  const alt = req.headers['x-mv-token'];
  if (alt && /^[A-Za-z0-9]+$/.test(String(alt))) return String(alt);
  // 不再接受 ?tk= query：token 会进浏览器历史、反代日志和 Referer
  return '';
}

// 默认不信任 X-Forwarded-For：客户端伪造它就能换一个限流桶。
// 只有部署在可信反向代理后、显式设置 TRUST_PROXY=1 时才解析 XFF。
const TRUST_PROXY = /^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY || '');
function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) {
      const first = String(fwd).split(',')[0].trim();
      if (/^[0-9a-fA-F:.]+$/.test(first)) return first;
    }
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* 简单滑动窗口限流：内存级，够单进程站点用 */
const buckets = new Map();

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count <= limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 5 * 60 * 1000).unref();

function isHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || !!(req.socket && req.socket.encrypted);
}

function sessionCookie(req, token, maxAge) {
  const parts = [
    'mv_session=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + (maxAge === undefined ? 2592000 : maxAge)
  ];
  if (isHttps(req) && Number(maxAge) !== 0) parts.push('Secure');
  return parts.join('; ');
}

function currentUser(req) {
  const token = bearerToken(req) || parseCookies(req)['mv_session'];
  if (!token) return null;
  const s = db.sessions[token];
  if (!s || s.exp < Date.now()) return null;
  const u = db.users.find((x) => x.id === s.uid);
  return u || null;
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function fail(res, status, msg) { send(res, status, { ok: false, error: msg }); }

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
  return {
    code: p.code,
    title: p.title,
    excerpt: excerptOf(p.statement),
    avgScore: p.scoreCount ? Math.round((p.scoreSum / p.scoreCount) * 10) / 10 : null,
    scoreCount: p.scoreCount || 0,
    myBest: best ? best.score : null,
    tags: p.tags,
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
}

function fullProblem(p, user) {
  const base = visibleProblem(p, user);
  const solved = user && user.solved ? user.solved[p.code] : null;
  return Object.assign(base, {
    statement: p.statement,
    hints: p.hints || [],
    authorName: p.authorName || '题库组',
    xp: xpForProblem(p, solved),
    mySolve: solved || null
  });
}

function xpForProblem(p, solve) {
  const base = 10 + p.difficulty * 3 + p.thinking + p.calc;
  if (!solve) return base;
  let factor = 1;
  if (solve.revealed) factor -= 0.4;
  if (solve.askedAI) factor -= 0.2;
  return Math.max(3, Math.round(base * Math.max(0.4, factor)));
}

function allTags() {
  const map = new Map();
  for (const p of db.problems) {
    if (p.status !== 'approved') continue;
    for (const t of p.tags) map.set(t, (map.get(t) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
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

function recentCodes(days) {
  const used = {};
  const now = new Date();
  for (let i = 1; i <= days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const code = db.daily[todayKey(d)];
    if (code) used[code] = true;
  }
  return used;
}

/* 每日一积候选：积分主题 + 难度 ≥ 6（较难），题干/标签/标题任一命中积分即可 */
function isIntegralProblem(p) {
  const hay = String(p.title || '') + ' ' + (p.tags || []).join(' ') + ' ' + String(p.statement || '');
  if (!/积分|定积分|不定积分|二重|三重|曲线积分|曲面积分|\\int|∫/.test(hay)) return false;
  return (p.difficulty || 0) >= 6;
}

function dailyProblem(dateKey) {
  const key = dateKey || todayKey();
  const approved = db.problems.filter((p) => p.status === 'approved');
  if (!approved.length) return null;
  // 管理员可以手动指定某天的题（db.dailyOverride[key] = code）
  const forced = (db.dailyOverride || {})[key];
  if (forced) {
    const fp = db.problems.find((x) => x.code === forced);
    if (fp) return fp;
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

function recentDaily(days, user) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = todayKey(d);
    let p = db.daily[key] ? db.problems.find((x) => x.code === db.daily[key]) : null;
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

/* ------------------------------------------------------------- LLM 调用 */

function llmConfigured() {
  return !!(db.settings.llm && db.settings.llm.apiKey);
}

/* 免费公共通道：不需要 Key，站点没配 Key 时自动兜底 */
const FREE_PROVIDERS = process.env.NO_FREE === '1' ? [] : [
  { name: 'Pollinations', baseUrl: 'https://text.pollinations.ai/openai', model: 'openai-fast' },
  { name: 'Pollinations', baseUrl: 'https://text.pollinations.ai/openai', model: 'openai' }
];

/* 免费网关偶尔直接回一段错误文本（HTTP 仍是 200），要识别出来继续往下降级 */
const RESPONSE_GUARD = /^(The API key used|Too Many Requests|Rate limit|Unauthorized|Forbidden|Bad Gateway)/i;

const OCR_PROMPT = [
  '你是数学题目转写工具。请把图片里的题目原样转写成 LaTeX。',
  '',
  '绝对规则：',
  '1. 不要改题目，不要改数字、符号、条件；',
  '2. 即使你认为题目有错（如漏条件、结论可疑），也不要修改，原样转写；',
  '3. 不要自己重新表述、不要补充题目没有的内容；',
  '4. 图片里有解答就一并转写；没有解答就不要编造。',
  '',
  '严格按下面格式输出，不要用 JSON、不要代码块、不要解释：',
  '[TITLE]',
  '不超过 18 字的纯文字标题（不要放公式）',
  '[STATEMENT]',
  '完整题干，公式用 $...$ 或 $$...$$ 包住',
  '[TAGS]',
  '最多 3 个考点，用顿号分隔',
  '[THINKING]',
  '1-10 的整数（只衡量「想到方法」的难度；纯计算题给 2-4）',
  '[DIFFICULTY]',
  '1-15 的整数',
  '[CALC]',
  '1-10 的整数',
  '[HINTS]',
  '1-2 条思路提示（没有就写：无）',
  '[ANSWER]',
  '最终答案（图片里没有就写：未给出）',
  '[SOLUTION]',
  '图片里的解答；没有就写：未给出'
].join('\n');

const EXPERT_SYSTEM = [
  '你是高等数学解题专家，带过考研与竞赛，不是通用聊天助手。',
  '',
  '回答按下面的顺序组织，可以按问题裁剪，但不要跳步：',
  '1. 审题：把条件与所求逐条翻译成数学语言，点出隐含条件（定义域、符号、端点、可导性）。',
  '2. 定位考点：给出 1-3 个考点名，说明这题为什么归到这类。',
  '3. 选策略：列出候选方法与取舍理由（为什么不用另一条路），只推一条主路径。',
  '4. 执行：分步推导，每步写清依据（定理名或公式名）。',
  '5. 验算：代回、特殊值、极限情形或量纲，至少做一种。',
  '6. 易错点：给 1-2 个最常见的错法，以及错在哪里。',
  '',
  '硬性要求：',
  '- 数学公式一律 LaTeX：行内 $...$，独立 $$...$$；',
  '- 信息不足就说不确定，绝不编造题目条件；',
  '- 学生只问某一步时，只讲那一步，不要直接甩完整答案；',
  '- 不要写「希望对你有所帮助」这类客套话，不说「作为一个 AI」。'
].join('\n');

/* 从题库里捞同考点题目，作为参考资料（只给题干和提示，不给解答，避免照抄） */
function retrieveSimilar(problem, limit) {
  if (!problem) return [];
  const tags = problem.tags || [];
  return db.problems
    .filter((p) => p.status === 'approved' && p.code !== problem.code && p.tags.some((t) => tags.includes(t)))
    .map((p) => ({ p, score: p.tags.filter((t) => tags.includes(t)).length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 3)
    .map((x) => x.p);
}

function llmMessages(problem, history, opts) {
  opts = opts || {};
  const sys = [EXPERT_SYSTEM];

  if (problem) {
    sys.push('');
    sys.push('## 当前题目');
    sys.push('编号：' + problem.code + '｜标题：' + problem.title);
    sys.push('考点：' + (problem.tags || []).join('、'));
    sys.push('题干：' + problem.statement);
    if (problem.hints && problem.hints.length) sys.push('题库分层提示（可逐层给出，不要一次全说）：' + problem.hints.join(' ｜ '));
    if (problem.solution) sys.push('题库标准解答（仅供你核对结论，讲解时按学生进度给，不要整段照搬）：' + problem.solution);
  }

  if (opts.expert !== false && problem) {
    const sims = retrieveSimilar(problem, 3);
    if (sims.length) {
      sys.push('');
      sys.push('## 题库里同类题（可作为类比素材，不要直接给答案）');
      for (const s of sims) {
        sys.push('- ' + s.code + ' ' + s.title + '：考点 ' + s.tags.join('、') + '；题干 ' + String(s.statement).slice(0, 160).replace(/\n+/g, ' '));
      }
    }
  }

  return [{ role: 'system', content: sys.join('\n') }].concat(
    (history || []).slice(-16).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }))
  );
}

/* ------------------------------------------------------- AI 出题 */

function buildGenerateMessages(spec) {
  const tags = (spec.tags && spec.tags.length) ? spec.tags.join('、') : '不定积分、定积分、极限、导数、中值定理等高等数学常见考点';
  const sys = [
    '你是高等数学命题老师，负责给大学生出原创练习题。',
    '',
    '严格按下面的分段格式输出，不要用 JSON、不要用代码块、不要写任何解释：',
    '',
    '[TITLE]',
    '不超过18字的纯文字标题（不要放公式）',
    '[STATEMENT]',
    '完整题干，公式用 $...$ 或 $$...$$ 包住，反斜杠照原样写',
    '[TAGS]',
    '2-3 个考点，用顿号分隔',
    '[THINKING]',
    '1-10 的整数',
    '[DIFFICULTY]',
    '1-10 的整数',
    '[CALC]',
    '1-10 的整数',
    '[HINTS]',
    '提示1',
    '提示2',
    '[ANSWER]',
    '最终答案',
    '[SOLUTION]',
    '分步解析，600 字以内，公式同样用 $ 或 $$ 包住',
    '',
    '要求：',
    '1. 题目必须数学上正确、可解，答案唯一（或说明多解）；',
    '2. 公式一定要有定界符，不要把 LaTeX 命令裸露在文字里；',
    '3. 不要照抄教材原题；',
    '4. 解析写清每一步的依据；',
    '5. 先在草稿里把题目算一遍、确认答案唯一且可验证，再输出；',
    '6. 不要出套一次公式就能做完的题，难度低于 6 的题目不要输出；',
    '6.1 打分口径：思维量只衡量「想到方法」有多难，纯计算题（套公式、代数变形）思维量给 2-4 分，把难度体现在计算量上；',
    '7. 考点最多写 3 个，难度允许超过 10（最高 ' + DIFF_MAX + '）。'
  ].join('\n');

  const user = [
    '请出一道高数题。',
    '考点范围：' + tags,
    '目标难度：' + spec.difficulty + '/' + DIFF_MAX,
    '目标思维量：' + (spec.thinking || 6) + '/10（需要多少洞察才能想到）',
    '目标计算量：' + spec.calc + '/10',
    spec.style ? ('题型偏好：' + spec.style) : '',
    spec.note ? ('额外要求：' + spec.note) : ''
  ].filter(Boolean).join('\n');

  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

/* 分段格式解析（LaTeX 里有 \frac \theta \right 这类，走 JSON 一定被转义吃掉） */
const SECTION_MAP = {
  TITLE: 'title', STATEMENT: 'statement', TAGS: 'tags',
  THINKING: 'thinking', DIFFICULTY: 'difficulty', CALC: 'calc',
  HINTS: 'hints', ANSWER: 'answer', SOLUTION: 'solution', SOURCE: 'source'
};

function parseGenerated(text) {
  const t = String(text || '').replace(/\r/g, '');
  const re = /^[ \t>*#-]*\[(TITLE|STATEMENT|TAGS|THINKING|DIFFICULTY|CALC|HINTS|ANSWER|SOLUTION|SOURCE)\][ \t:：]*$/gim;
  const marks = [];
  let m;
  while ((m = re.exec(t)) !== null) marks.push({ key: SECTION_MAP[m[1].toUpperCase()], start: m.index, bodyStart: re.lastIndex });
  if (marks.length < 2) return null;

  const obj = {};
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1].start : t.length;
    const body = t.slice(cur.bodyStart, end).replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/,'').trim();
    if (cur.key === 'tags') obj.tags = body.split(/[,，、\n]+/).map((x) => x.trim()).filter(Boolean);
    else if (cur.key === 'hints') obj.hints = body.split('\n').map((x) => x.replace(/^[-*·•]\s*/, '').trim()).filter(Boolean);
    else if (['thinking', 'difficulty', 'calc'].includes(cur.key)) {
      const num = body.match(/\d+/);
      obj[cur.key] = num ? Number(num[0]) : undefined;
    } else obj[cur.key] = body;
  }
  if (!obj.statement || obj.statement.length < 10) return null;
  return obj;
}

function repairJsonText(raw) {
  let out = '';
  let inStr = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      const next = raw[i + 1];
      if (next === '\\' || next === '"' || next === '/') { out += '\\' + next; i += 2; continue; }
      if (next === 'b' || next === 'f' || next === 'n' || next === 'r' || next === 't') { out += '\\' + next; i += 2; continue; }
      if (next === 'u') { out += raw.slice(i, i + 6); i += 6; continue; }
      out += '\\\\';
      i += 1;
      continue;
    }
    if (ch === '"') { inStr = false; out += ch; i += 1; continue; }
    if (ch === '\n') { out += '\\n'; i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\t') { out += '\\t'; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

function extractJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  const raw = t.slice(i, j + 1);

  try { return JSON.parse(raw); } catch (e) {}

  // 模型常把 LaTeX 反斜杠写成单转义（\frac），JSON 会报 Bad escaped character，做一次逐字符修复
  let fixed = repairJsonText(raw);
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(fixed); } catch (e) {}

  try {
    const loose = JSON.parse(fixed, function (k, v) { return v; });
    return loose;
  } catch (e) {}
  return null;
}

function validateGenerated(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const item = normalizeProblem(raw);
  if (!item) return null;

  // 标题要能放进列表：去掉公式与换行，实在不能用在就让用户自己改
  let title = String(item.title || '').replace(/\$\$?/g, '').replace(/\s+/g, ' ').trim();
  if (/\\[a-zA-Z]/.test(title) || title.length < 4) title = '待命名 · ' + (item.tags || []).slice(0, 2).join(' / ');
  item.title = title.slice(0, 40);

  if (item.statement.length < 20 || (item.solution || '').length < 40) return null;
  item.source = String(raw.source || 'AI 出题 · 待人工审核').slice(0, 80);
  return item;
}

/* 模型链：用户自带 Key → 站点 Key → 免费通道 → 本地讲解
   baseUrl 由客户端提供，必须先白名单校验再交给服务端 fetch，否则就是 SSRF。 */
const LLM_HOSTS = new Set([
  'api.deepseek.com', 'api.openai.com', 'open.bigmodel.cn', 'dashscope.aliyuncs.com',
  'generativelanguage.googleapis.com', 'api.anthropic.com', 'api.groq.com', 'openrouter.ai',
  'api.moonshot.cn', 'api.minimax.chat', 'text.pollinations.ai', 'pollinations.ai',
  'api.x.ai', 'api.cohere.com', 'api.together.xyz', 'api.fireworks.ai',
  // 免费视觉通道常被用到的几家
  'api.sensenova.cn', 'api-inference.modelscope.cn', 'api.siliconflow.cn',
  'ark.cn-beijing.volces.com', 'hunyuan.tencentcloudapi.com', 'qianfan.baidubce.com'
]);
for (const h of String(process.env.LLM_ALLOWED_HOSTS || '').split(',')) {
  const v = h.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (v) LLM_HOSTS.add(v);
}

function safeLlmBaseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '443') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  // 裸 IP（IPv4/IPv6）、本机与内网域名一律拒绝；再要求命中域名白名单
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.indexOf(':') >= 0) return null;
  if (host === 'localhost' || /\.localhost$/.test(host) || /\.local$/.test(host) || /\.internal$/.test(host)) return null;
  let allowed = false;
  for (const d of LLM_HOSTS) {
    if (host === d || host.endsWith('.' + d)) { allowed = true; break; }
  }
  if (!allowed) return null;
  // 只保留 path，丢掉 query/hash，避免把密钥拼进 URL 后被日志/代理记录
  const path = u.pathname.replace(/\/+$/, '').slice(0, 120);
  return 'https://' + host + path;
}

function userLlmConfig(body) {
  const l = body && body.llm;
  if (!l || !l.apiKey) return null;
  const baseUrl = safeLlmBaseUrl(l.baseUrl || 'https://api.deepseek.com/v1');
  if (!baseUrl) return null;
  return {
    name: '我的 Key',
    mode: 'user-key',
    baseUrl: baseUrl,
    model: String(l.model || 'deepseek-chat').trim().slice(0, 80),
    apiKey: String(l.apiKey).trim()
  };
}

function llmCandidates(body) {
  const list = [];
  const own = userLlmConfig(body);
  if (own) list.push(own);
  const siteBase = safeLlmBaseUrl(db.settings.llm.baseUrl);
  if (llmConfigured() && siteBase) {
    list.push({
      name: '站点模型', mode: 'site',
      baseUrl: siteBase,
      model: db.settings.llm.model,
      apiKey: db.settings.llm.apiKey
    });
  }
  // 站点识图专用 Key（管理员配置），给全站用户读图用
  const vs = db.settings.llmVision;
  const vBase = vs ? safeLlmBaseUrl(vs.baseUrl) : null;
  if (vs && vs.apiKey && vBase) {
    list.push({
      name: '站点识图模型', mode: 'site',
      baseUrl: vBase, model: vs.model, apiKey: vs.apiKey
    });
  }
  if (!body || !body.skipFree) {
    for (const f of FREE_PROVIDERS) {
      list.push({ name: f.name, mode: 'free', baseUrl: f.baseUrl, model: f.model, apiKey: '', timeout: 22000 });
    }
  }
  return list;
}

async function openChat(cfg, messages, stream) {
  const base = safeLlmBaseUrl(cfg.baseUrl || '');
  if (!base) throw new Error(cfg.name + ' 的接口地址不合法或不在域名白名单内');
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeout || 30000);
  let resp;
  try {
    resp = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0.6, stream: !!stream }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(cfg.name + ' 返回 ' + resp.status + ' ' + t.slice(0, 120));
  }
  return resp;
}

async function callLLM(cfg, messages) {
  const resp = await openChat(cfg, messages, false);
  const j = await resp.json();
  const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  if (RESPONSE_GUARD.test(text.trim())) throw new Error(cfg.name + ' 返回异常内容: ' + text.slice(0, 60));
  return text;
}

async function streamLLM(cfg, messages, onDelta) {
  const resp = await openChat(cfg, messages, true);
  if (!resp.body) throw new Error(cfg.name + ' 没有返回内容');
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let got = 0;
  let pre = '';
  let flushed = false;

  const push = (c) => {
    if (!c) return;
    if (!flushed) {
      pre += c;
      if (pre.length < 24) return;
      if (RESPONSE_GUARD.test(pre.trim())) throw new Error('返回异常内容: ' + pre.slice(0, 60));
      flushed = true;
      got += pre.length;
      onDelta(pre);
      return;
    }
    got += c.length;
    onDelta(c);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        if (!flushed && pre) {
          if (RESPONSE_GUARD.test(pre.trim())) throw new Error('返回异常内容: ' + pre.slice(0, 60));
          got += pre.length;
          onDelta(pre);
          flushed = true;
        }
        return got;
      }
      try {
        const j = JSON.parse(data);
        const c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        push(c);
      } catch (e) {
        if (String(e.message || '').indexOf('返回异常内容') === 0) throw e;
      }
    }
  }
  if (!flushed && pre && !RESPONSE_GUARD.test(pre.trim())) { got += pre.length; onDelta(pre); }
  return got;
}

/* --------------------------------------------------------- 答疑区 AI 回帖 */

async function generateForumReply(post, problem, ask) {
  const sys = {
    role: 'system',
    content: '你是「Advanced-Math-Vault」答疑区的 AI 助教。回答要短（150-300 字）、直接、有可执行的第一步，公式用 $...$。'
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
   站点没有配 SMTP，验证码会直接回给前端（面板上显示），
   这对个人站够用；将来接真实邮件服务只需替换 sendMailCode。 */
function genCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function sendMailCode(email, code) {
  // 没有 SMTP 时：记录到日志，返回给前端展示
  console.log('[mail] 验证码 ' + code + ' -> ' + email);
  return { delivered: false, code };
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
      '你是 Advanced-Math-Vault 题库的审题助理。用户提交了一条对题目的反馈，你要先替管理员审阅一遍。',
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
    isMine: !!(user && f.userId === user.id)
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
  [/\/answer$/, 40, 60 * 60 * 1000, '判题刷得太快了，歇一会儿']
];

async function handleApi(req, res, pathname, query) {
  const user = currentUser(req);
  const method = req.method;

  if (method === 'POST') {
    const ip = clientIp(req);
    for (const [re, limit, win, msg] of RATE_RULES) {
      if (re.test(pathname) && !rateLimit(ip + '|' + pathname, limit, win)) {
        return fail(res, 429, msg);
      }
    }
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
        tags: allTags().length
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

  /* ---- 账号 ---- */
  if (pathname === '/api/auth/register' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    if (name.length < 2 || name.length > 16) return fail(res, 400, '用户名需要 2-16 个字符');
    if (!/^[\w\u4e00-\u9fa5.-]+$/.test(name)) return fail(res, 400, '用户名只能包含中英文、数字、下划线');
    if (password.length < 8) return fail(res, 400, '密码至少 8 位');
    if (db.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) return fail(res, 409, '这个名字已经有人用了');
    const { salt, hash } = hashPassword(password);
    const isFirst = db.users.length === 0;
    const u = {
      id: crypto.randomUUID(),
      name,
      salt,
      passHash: hash,
      role: isFirst ? 'admin' : 'user',
      exp: 0,
      solved: {},
      activity: [],
      createdAt: new Date().toISOString()
    };
    db.users.push(u);
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = { uid: u.id, exp: Date.now() + 30 * 864e5 };
    saveDb();
    res.setHeader('Set-Cookie', sessionCookie(req, token));
    return send(res, 200, { ok: true, user: publicUser(u, true), token, isFirstAdmin: isFirst });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    const u = db.users.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!u || !verifyPassword(password, u)) return fail(res, 401, '用户名或密码不正确');
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = { uid: u.id, exp: Date.now() + 30 * 864e5 };
    saveDb();
    res.setHeader('Set-Cookie', sessionCookie(req, token));
    return send(res, 200, { ok: true, user: publicUser(u, true), token });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const token = bearerToken(req) || parseCookies(req)['mv_session'];
    if (token && db.sessions[token]) { delete db.sessions[token]; saveDb(); }
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/password' && method === 'POST') {
    if (!user) return fail(res, 401, '请先登录');
    const body = await readBody(req);
    const oldPwd = String(body.oldPassword || '');
    const newPwd = String(body.newPassword || '');
    if (!verifyPassword(oldPwd, user)) return fail(res, 400, '原密码不正确');
    if (newPwd.length < 8) return fail(res, 400, '新密码至少 8 位');
    const { salt, hash } = hashPassword(newPwd);
    user.salt = salt;
    user.passHash = hash;
    // 其他会话失效
    const keep = bearerToken(req) || parseCookies(req)['mv_session'];
    for (const k of Object.keys(db.sessions)) if (db.sessions[k].uid === user.id && k !== keep) delete db.sessions[k];
    saveDb(true);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/me' && method === 'GET') {
    return send(res, 200, { ok: true, user: publicUser(user, true), activity: (user && user.activity) || [] });
  }

  /* ---- 邮箱绑定：发验证码 ---- */
  if (pathname === '/api/me/email/send' && method === 'POST') {
    if (!user) return fail(res, 401, '请先登录');
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(res, 400, '邮箱格式不对');
    if (db.users.some((u) => u.id !== user.id && (u.email || '').toLowerCase() === email && u.emailVerified)) {
      return fail(res, 409, '这个邮箱已经被其他账号绑定了');
    }
    const code = genCode();
    db.emailCodes[user.id] = { email, code, exp: Date.now() + 5 * 60 * 1000, tries: 0 };
    saveDb();
    const r = sendMailCode(email, code);
    return send(res, 200, {
      ok: true,
      delivered: r.delivered,
      // 不再把验证码回给前端（否则谁都能绑定任意假邮箱）；本地部署看服务端日志
      code: process.env.NODE_ENV === 'development' && !r.delivered ? code : undefined,
      message: r.delivered ? '验证码已发送到邮箱' : '站点未接入邮件服务，验证码已写入服务端日志（开发模式会直接返回）'
    });
  }

  /* ---- 判分申诉：对 AI 打分不服，转人工复核 ---- */
  if (pathname === '/api/submissions/appeal' && method === 'POST') {
    if (!user) return fail(res, 401, '请先登录');
    const body = await readBody(req);
    const sid = String(body.submissionId || '').trim();
    const reason = String(body.reason || '').trim();
    if (!sid) return fail(res, 400, '缺少提交记录');
    if (reason.length < 6) return fail(res, 400, '请写清申诉理由（至少 6 个字）');
    const sub = (db.submissions || []).find((x) => x.id === sid && x.uid === user.id);
    if (!sub) return fail(res, 404, '找不到这条提交记录');
    const dup = (db.feedbacks || []).find((f) => f.submissionId === sid && f.status === 'open');
    if (dup) return send(res, 200, { ok: true, id: dup.id, message: '这条已经在等人工复核了' });
    const fb = {
      id: db.meta.feedbackSeq++,
      code: sub.code,
      type: 'appeal',
      content: ('申诉判分：' + reason).slice(0, 2000),
      imageDesc: '',
      userId: user.id,
      userName: user.name,
      createdAt: new Date().toISOString(),
      status: 'open',
      ai: null,
      adminNote: '',
      handledAt: null,
      handlerName: '',
      submissionId: sid,
      submissionScore: sub.score || 0,
      submissionAt: sub.at || ''
    };
    db.feedbacks.push(fb);
    saveDb();
    logActivity(user, '对 ' + sub.code + ' 的判分提出申诉', sub.code);
    return send(res, 200, { ok: true, id: fb.id, message: '已转人工复核，结果会在反馈里回复' });
  }

  /* ---- 今日复习：间隔重复队列 ---- */
  if (pathname === '/api/my/review-today' && method === 'GET') {
    if (!user) return fail(res, 401, '请先登录');
    const now = Date.now();
    const wrong = user.wrong || {};
    const dueCodes = [];
    for (const [code, w] of Object.entries(wrong)) {
      const p = db.problems.find((x) => x.code === code && x.status === 'approved');
      if (!p) continue;
      if ((w.nextReviewAt || 0) <= now) dueCodes.push(code);
    }
    const items = dueCodes.slice(0, 10).map((code) => {
      const p = db.problems.find((x) => x.code === code);
      const w = wrong[code];
      return {
        code, title: p.title, difficulty: p.difficulty, tags: p.tags,
        intervalDays: w.intervalDays || 1, lastScore: w.score || 0, tries: w.tries || 0
      };
    });
    return send(res, 200, { ok: true, items, due: dueCodes.length, total: Object.keys(wrong).length });
  }

  /* ---- 我的考点统计：按标签聚合 + 薄弱考点 + 推荐题 ---- */
  if (pathname === '/api/my/stats' && method === 'GET') {
    if (!user) return fail(res, 401, '请先登录');
    const solvedMap = user.solved || {};
    const bestMap = user.best || {};
    const agg = new Map();
    let attempts = 0, passedCount = 0, scoreSum = 0;
    for (const [code, rec] of Object.entries(solvedMap)) {
      const p = db.problems.find((x) => x.code === code);
      if (!p) continue;
      const sc = (bestMap[code] && bestMap[code].score) || (rec.done ? 100 : 0);
      attempts++; scoreSum += sc;
      if (rec.done) passedCount++;
      for (const t of p.tags || []) {
        const o = agg.get(t) || { tag: t, attempts: 0, passed: 0, scoreSum: 0 };
        o.attempts++; if (rec.done) o.passed++; o.scoreSum += sc;
        agg.set(t, o);
      }
    }
    const tags = [...agg.values()].map((o) => ({
      tag: o.tag, attempts: o.attempts, passed: o.passed,
      rate: Math.round((o.passed / o.attempts) * 100),
      avgScore: Math.round(o.scoreSum / o.attempts)
    })).sort((a, b) => b.attempts - a.attempts);
    const weakest = tags.slice()
      .filter((t) => t.attempts >= 1 && t.passed < t.attempts)
      .sort((a, b) => a.rate - b.rate || a.avgScore - b.avgScore)
      .slice(0, 3);
    const recommend = [];
    for (const w of weakest) {
      for (const p of db.problems) {
        if (recommend.length >= 6) break;
        if (p.status !== 'approved') continue;
        if (!(p.tags || []).includes(w.tag)) continue;
        if (solvedMap[p.code] && solvedMap[p.code].done) continue;
        if (recommend.some((r) => r.code === p.code)) continue;
        recommend.push({ code: p.code, title: p.title, difficulty: p.difficulty, tag: w.tag });
      }
    }
    return send(res, 200, {
      ok: true,
      summary: {
        attempts, passed: passedCount, solved: passedCount,
        rate: attempts ? Math.round((passedCount / attempts) * 100) : 0,
        avgScore: attempts ? Math.round(scoreSum / attempts) : 0,
        wrong: Object.keys(user.wrong || {}).length
      },
      tags, weakest, recommend
    });
  }

  /* ---- 邮箱绑定：校验 ---- */
  if (pathname === '/api/me/email/verify' && method === 'POST') {
    if (!user) return fail(res, 401, '请先登录');
    const body = await readBody(req);
    const code = String(body.code || '').trim();
    const rec = db.emailCodes[user.id];
    if (!rec) return fail(res, 400, '请先发送验证码');
    if (Date.now() > rec.exp) { delete db.emailCodes[user.id]; return fail(res, 400, '验证码已过期，请重新发送'); }
    if (rec.tries >= 5) { delete db.emailCodes[user.id]; return fail(res, 429, '尝试次数过多，请重新发送'); }
    rec.tries++;
    if (code !== rec.code) return fail(res, 400, '验证码不对');
    user.email = rec.email;
    user.emailVerified = true;
    user.emailVerifiedAt = new Date().toISOString();
    delete db.emailCodes[user.id];
    saveDb(true);
    return send(res, 200, { ok: true, user: publicUser(user, true) });
  }

  /* ---- 题库 ---- */
  if (pathname === '/api/problems' && method === 'GET') {
    const codeList = String(query.c || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
    const q = String(query.q || '').trim().toLowerCase();
    const tags = String(query.tags || '').split(',').filter(Boolean);
    const level = String(query.level || '').trim();
    const status = String(query.status || 'all');
    const sort = String(query.sort || 'code');
    const page = Math.max(1, Number(query.page || 1));
    const size = Math.max(5, Math.min(50, Number(query.size || 20)));

    let list = db.problems.filter((p) => p.status === 'approved');
    if (q) {
      list = list.filter((p) =>
        p.title.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q)) ||
        String(p.source || '').toLowerCase().includes(q)
      );
    }
    if (codeList.length) list = list.filter((p) => codeList.includes(p.code));
    if (tags.length) list = list.filter((p) => tags.every((t) => p.tags.includes(t)));
    if (level) list = list.filter((p) => levelOf(p.difficulty).name === level);
    if (status === 'solved') list = list.filter((p) => user && user.solved && user.solved[p.code]);
    if (status === 'unsolved') list = list.filter((p) => !(user && user.solved && user.solved[p.code]));

    const sorters = {
      code: (a, b) => a.code.localeCompare(b.code),
      difficulty: (a, b) => b.difficulty - a.difficulty || a.code.localeCompare(b.code),
      thinking: (a, b) => b.thinking - a.thinking,
      calc: (a, b) => b.calc - a.calc,
      newest: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt))
    };
    list.sort(sorters[sort] || sorters.code);

    const total = list.length;
    const items = list.slice((page - 1) * size, page * size).map((p) => {
      const v = visibleProblem(p, user);
      if (codeList.length) {
        v.statement = p.statement;
        const solved = user && user.solved && user.solved[p.code];
        v.answer = (solved && (solved.done || solved.revealed)) ? (p.answer || '') : '';
        v.answerLocked = !v.answer;
      }
      return v;
    });
    return send(res, 200, {
      ok: true, items, total, page, size,
      pages: Math.max(1, Math.ceil(total / size)),
      tags: allTags(),
      levels: LEVELS.map((l) => l.name)
    });
  }

  const problemMatch = pathname.match(/^\/api\/problems\/([A-Za-z0-9-]+)(\/[a-z]+)?$/);
  if (problemMatch) {
    const code = problemMatch[1].toUpperCase();
    const sub = problemMatch[2];
    const p = db.problems.find((x) => x.code === code);
    if (!p) return fail(res, 404, '题目不存在');
    if (p.status !== 'approved' && !(user && (user.role === 'admin' || user.id === p.authorId))) {
      return fail(res, 404, '题目不存在');
    }

    /* 题目反馈：用户提交 → AI 先审阅 → 再转管理员 */
    if (sub === '/feedback' && method === 'POST') {
      if (!user) return fail(res, 401, '请先登录再提交反馈');
      const body = await readBody(req);
      const content = String(body.content || '').trim();
      const type = FEEDBACK_TYPES[body.type] ? String(body.type) : 'other';
      if (content.length < 6) return fail(res, 400, '反馈内容至少 6 个字，请说清是哪一步有问题');
      const imageDesc = String(body.imageDesc || '').slice(0, 200);
      const fb = {
        id: db.meta.feedbackSeq++,
        code: p.code,
        type,
        content: content.slice(0, 2000),
        imageDesc,
        userId: user.id,
        userName: user.name,
        createdAt: new Date().toISOString(),
        status: 'open',
        ai: null,
        adminNote: '',
        handledAt: null,
        handlerName: ''
      };
      db.feedbacks.push(fb);
      saveDb();
      logActivity(user, '反馈了题目 ' + p.code, p.code);
      scheduleFeedbackReview(fb.id);
      return send(res, 200, { ok: true, id: fb.id, message: '反馈已提交，AI 审阅后会转给管理员' });
    }

    if (sub === '/feedback' && method === 'GET') {
      if (!user) return fail(res, 401, '请先登录');
      const mine = db.feedbacks.filter((f) => f.code === p.code && f.userId === user.id);
      return send(res, 200, { ok: true, items: mine.map((f) => publicFeedback(f, user)) });
    }

    if (!sub && method === 'GET') {
      p.views = (p.views || 0) + 1;
      saveDb();
      return send(res, 200, {
        ok: true,
        problem: fullProblem(p, user),
        xpRules: { base: 10 + p.difficulty * 3 + p.thinking + p.calc, revealedPenalty: 0.4, aiPenalty: 0.2 },
        related: db.problems
          .filter((x) => x.status === 'approved' && x.code !== p.code && x.tags.some((t) => p.tags.includes(t)))
          .slice(0, 4)
          .map((x) => ({ code: x.code, title: x.title, difficulty: x.difficulty, levelColor: levelOf(x.difficulty).color }))
      });
    }

    if (sub === '/reveal' && method === 'POST') {
      p.attemptCount = (p.attemptCount || 0) + 1;
      if (user) {
        user.solved = user.solved || {};
        const rec = user.solved[p.code];
        if (!rec) {
          user.solved[p.code] = { at: Date.now(), revealed: true, askedAI: false, done: false };
        } else {
          rec.revealed = true;
        }
      }
      saveDb();
      return send(res, 200, {
        ok: true,
        answer: p.answer || '',
        solution: p.solution || '',
        hints: p.hints || []
      });
    }

    if (sub === '/answer' && method === 'POST') {
      if (!user) return fail(res, 401, '登录后才能提交');      const body = await readBody(req, 8 * 1024 * 1024);
      const process = String(body.process || '').trim().slice(0, 4000);
      const answerOnly = body.mode === 'answer' || (!process && String(body.answer || '').trim());
      const only = process || String(body.answer || '').trim();
      const image = typeof body.image === 'string' && body.image.indexOf('data:image/') === 0 ? body.image : '';
      user.solved = user.solved || {};
      user.best = user.best || {};
      user.wrong = user.wrong || {};
      const rec = user.solved[p.code];
      if (rec && rec.done) {
        return send(res, 200, { ok: true, already: true, verdict: 'correct', score: 100, comment: '这道题已经通过了，不用再交', errors: [] });
      }

      if (!only && !image) return fail(res, 400, '写点东西再交：过程，或者至少给出最终答案');
      if (!answerOnly && only && only.length < 20) return fail(res, 400, '过程太短了：至少写清用了什么方法、关键几步怎么来的');

      p.attemptCount = (p.attemptCount || 0) + 1;
      user.attempts = (user.attempts || 0) + 1;   // 用于排行榜显示「做过多少题」

      const own = userLlmConfig(body);
      if (image && !(own && VISION_MODEL.test(own.model))) {
        saveDb();
        return send(res, 200, {
          ok: true, verdict: 'unclear', needVision: true,
          comment: '当前通道读不了图片：在「设置」里填支持图片的 Key（gpt-4o / qwen-vl / glm-4v / claude / gemini），或者把过程打成文字再交',
          errors: []
        });
      }

      const prior = db.submissions
        .filter((x) => x.uid === user.id && x.code === p.code)
        .slice(-3);

      let judged = null;
      let judgedBy = '';
      for (const cfg of llmCandidates(body)) {
        if (image && !VISION_MODEL.test(cfg.model || '')) continue;
        try {
          let msgs = judgeMessages(p, only, !!image, { history: prior, answerOnly });
          if (image) {
            msgs = [msgs[0], {
              role: 'user',
              content: [
                { type: 'text', text: msgs[1].content },
                { type: 'image_url', image_url: { url: image } }
              ]
            }];
          }
          const out = await callLLM(cfg, msgs);
          const parsed = parseJudge(out);
          judgedBy = cfg.name;
          if (parsed.verdict && parsed.verdict !== 'unclear') { judged = parsed; break; }
        } catch (e) {
          console.error('[judge] ' + cfg.name + ' 失败:', e.message);
        }
      }

      if (!judged) {
        if (processMatchesAnswer(only, p.answer)) {
          judged = {
            verdict: 'correct',
            score: answerOnly ? 80 : 100,
            comment: answerOnly
              ? '暂时连不上阅卷模型，只核对了最终答案（正确），按规则给 80 分。'
              : '暂时连不上阅卷模型；已核对结论行的答案正确，按规则给满分，中间步骤未逐项核对。',
            errors: []
          };
          judgedBy = '规则比对';
        } else if (answerOnly) {
          // 只交答案又对不上：直接判错并重扣，别让用户以为「没判」
          judged = { verdict: 'wrong', score: 30, comment: '最终答案和标准答案不一致。只交答案时只核对这一项，请检查计算过程。', errors: [] };
          judgedBy = '规则比对';
        } else {
          saveDb();
          return send(res, 200, {
            ok: true, verdict: 'unclear', judgedBy: '未判定',
            comment: '暂时连不上阅卷模型（免费通道有频率限制），稍后再交一次；想立刻判分可以在「设置」里填自己的 Key。',
            errors: []
          });
        }
      }

      // 分数线与给分规则（2026-11-25 调整）：
      //   正确答案 + 简要思路/过程 → 100 分，中间跳步不扣分
      //   只交正确答案            → 80 分，通过
      //   最终答案错误            → 大幅扣分，不过线
      // 模型常因「跳步 / 不够严谨」把 verdict 压到 partial，这里按结论行的最终答案兜底纠正，
      // 避免同一份提交「无模型 80 分过、有模型 79 分挂」。
      const answerConfirmed = processMatchesAnswer(only, p.answer);
      if (answerConfirmed && judged.verdict !== 'wrong') {
        judged = Object.assign({}, judged, {
          verdict: 'correct',
          score: answerOnly ? 80 : 100,
          comment: answerOnly
            ? '最终答案正确；只交答案按 80 分计，通过。'
            : '最终答案正确；按现行规则，写了思路或过程即给满分，中间步骤未逐项核对。',
          errors: []
        });
      }
      let score = Number.isFinite(judged.score) ? Math.round(judged.score) : 0;
      score = Math.max(0, Math.min(100, score));
      let verdict = judged.verdict;
      if (verdict === 'correct') {
        const base = answerOnly ? 80 : 100;
        score = Math.max(base, score);
      } else if (verdict === 'wrong') {
        score = Math.min(score || 40, 50);   // 出错重罚
      } else {
        score = Math.min(score, 79);         // 部分对/说不清，不给过
      }
      const PASS = 80;
      const passed = verdict === 'correct' && score >= PASS;

      // 记录这次提交
      const submission = {
        id: 'S' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        code: p.code,
        uid: user.id,
        name: user.name,
        at: new Date().toISOString(),
        mode: answerOnly ? 'answer' : 'process',
        process: only.slice(0, 2000),
        hasImage: !!image,
        score: score,
        verdict: verdict,
        comment: judged.comment || '',
        errors: (judged.errors || []).slice(0, 6),
        judgedBy: judgedBy
      };
      db.submissions.push(submission);
      // 每人每题最多留 10 条，避免库无限膨胀
      const same = db.submissions.filter((x) => x.uid === user.id && x.code === p.code);
      if (same.length > 10) {
        const drop = same.slice(0, same.length - 10).map((x) => x.id);
        db.submissions = db.submissions.filter((x) => drop.indexOf(x.id) < 0);
      }

      // 题目统计
      p.scoreSum = (p.scoreSum || 0) + score;
      p.scoreCount = (p.scoreCount || 0) + 1;

      // 用户最高分
      const best = user.best[p.code];
      const isBest = !best || score > best.score;
      if (isBest) user.best[p.code] = { score: score, at: submission.at };

      const payload = {
        ok: true,
        verdict: verdict,
        score: score,
        passed: passed,
        passLine: PASS,
        comment: judged.comment || '',
        errors: judged.errors || [],
        judgedBy: judgedBy,
        submissionId: submission.id,
        appealable: !passed,
        attempt: prior.length + 1,
        isBest: isBest,
        myBest: user.best[p.code].score,
        avgScore: p.scoreCount ? Math.round((p.scoreSum / p.scoreCount) * 10) / 10 : null,
        scoreCount: p.scoreCount
      };

      if (passed) {
        const gained = xpForProblem(p, rec);
        user.solved[p.code] = {
          at: (rec && rec.at) || Date.now(),
          done: true,
          revealed: !!(rec && rec.revealed),
          askedAI: !!(rec && rec.askedAI),
          judged: judgedBy,
          score: score
        };
        user.exp = (user.exp || 0) + gained;
        p.solvedCount = (p.solvedCount || 0) + 1;
        /* 错题本按间隔重复推进：复习正确间隔翻倍，连续掌握到 8 天才出本 */
        const wRec = user.wrong[p.code];
        if (wRec) {
          wRec.intervalDays = Math.min(16, (wRec.intervalDays || 1) * 2);
          wRec.lastResult = 'pass';
          wRec.lastScore = score;
          wRec.lastReviewAt = Date.now();
          wRec.nextReviewAt = Date.now() + wRec.intervalDays * 864e5;
          if (wRec.intervalDays >= 8) delete user.wrong[p.code];
        }
        logActivity(user, '做出 ' + p.code + '（' + score + ' 分），+' + gained + ' 经验', p.code);
        saveDb();
        return send(res, 200, Object.assign(payload, {
          gained: gained, exp: user.exp, level: levelInfo(user.exp), user: publicUser(user)
        }));
      }

      // 没过线：记一次尝试，进错题本
      user.solved[p.code] = {
        at: (rec && rec.at) || Date.now(),
        done: false,
        revealed: !!(rec && rec.revealed),
        askedAI: !!(rec && rec.askedAI)
      };
      const prevWrong = user.wrong[p.code];
      user.wrong[p.code] = {
        at: submission.at,
        score: score,
        tries: (prevWrong && prevWrong.tries ? prevWrong.tries : 0) + 1,
        intervalDays: 1,                                  // 错了就重置为 1 天
        lastResult: 'fail',
        lastReviewAt: Date.now(),
        nextReviewAt: Date.now()                          // 刚错的题立刻进今日复习队列
      };
      saveDb();
      return send(res, 200, payload);
    }

    if (sub === '/history' && method === 'GET') {
      if (!user) return send(res, 200, { ok: true, items: [] });
      const items = db.submissions
        .filter((x) => x.uid === user.id && x.code === p.code)
        .slice(-10)
        .reverse()
        .map((x) => ({
          id: x.id, at: x.at, mode: x.mode, score: x.score, verdict: x.verdict,
          comment: x.comment, errors: x.errors, process: x.process, hasImage: x.hasImage
        }));
      return send(res, 200, { ok: true, items, best: (user.best[p.code] || {}).score || null });
    }

    if (sub === '/solve' && method === 'POST') {
      if (!user) return fail(res, 401, '登录后才能记录做题进度');
      user.solved = user.solved || {};
      const rec = user.solved[p.code];
      if (rec && rec.done) return send(res, 200, { ok: true, already: true, exp: user.exp, gained: 0, level: levelInfo(user.exp) });
      const gained = xpForProblem(p, rec);
      user.solved[p.code] = {
        at: (rec && rec.at) || Date.now(),
        done: true,
        revealed: !!(rec && rec.revealed),
        askedAI: !!(rec && rec.askedAI)
      };
      user.exp = (user.exp || 0) + gained;
      p.solvedCount = (p.solvedCount || 0) + 1;
      logActivity(user, '做出 ' + p.code + '，+' + gained + ' 经验', p.code);
      saveDb();
      return send(res, 200, { ok: true, gained, exp: user.exp, level: levelInfo(user.exp), user: publicUser(user) });
    }

    if (sub === '/ai-flag' && method === 'POST') {
      if (user) {
        user.solved = user.solved || {};
        const rec = user.solved[p.code];
        if (rec) rec.askedAI = true;
        else user.solved[p.code] = { at: Date.now(), revealed: false, askedAI: true, done: false };
        saveDb();
      }
      return send(res, 200, { ok: true });
    }
  }

  /* ---- 每日一题 ---- */
  if (pathname === '/api/daily' && method === 'GET') {
    const p = dailyProblem();
    return send(res, 200, {
      ok: true,
      date: todayKey(),
      problem: p ? Object.assign(visibleProblem(p, user), { statement: p.statement }) : null,
      recent: recentDaily(8, user)
    });
  }

  /* ---- 顺序刷 / 随机刷 ---- */
  if (pathname === '/api/practice' && method === 'GET') {
    const mode = query.mode === 'random' ? 'random' : 'seq';
    const tags = String(query.tags || '').split(',').map((x) => x.trim()).filter(Boolean);
    const dmin = Number(query.dmin || 1);
    const dmax = Number(query.dmax || DIFF_MAX);
    let pool = db.problems.filter((p) => p.status === 'approved');
    if (tags.length) pool = pool.filter((p) => p.tags.some((t) => tags.includes(t)));
    pool = pool.filter((p) => p.difficulty >= dmin && p.difficulty <= dmax);
    if (user) {
      const solved = user.solved || {};
      pool = pool.filter((p) => !(solved[p.code] && solved[p.code].done));
    }
    if (!pool.length) return send(res, 200, { ok: true, code: null, remaining: 0 });
    pool.sort((a, b) => a.code.localeCompare(b.code));
    let pick;
    if (mode === 'random') {
      pick = pool[Math.floor(Math.random() * pool.length)];
    } else {
      const after = String(query.after || '').toUpperCase();
      const idx = after ? pool.findIndex((p) => p.code > after) : 0;
      pick = pool[idx < 0 ? 0 : idx];
    }
    return send(res, 200, { ok: true, code: pick.code, remaining: pool.length, mode });
  }

  /* ---- 错题本 ---- */
  if (pathname === '/api/wrongbook' && method === 'GET') {
    if (!user) return fail(res, 401, '登录后才有错题本');
    const out = [];
    for (const [code, v] of Object.entries(user.wrong || {})) {
      const p = db.problems.find((x) => x.code === code);
      if (!p || p.status !== 'approved') continue;
      out.push({
        code: p.code, title: p.title, tags: p.tags, difficulty: p.difficulty,
        thinking: p.thinking, calc: p.calc,
        levelColor: levelOf(p.difficulty).color,
        myScore: v.score, tries: v.tries, at: v.at,
        intervalDays: v.intervalDays || 1,
        nextReviewAt: v.nextReviewAt || 0,
        lastResult: v.lastResult || '',
        due: (v.nextReviewAt || 0) <= Date.now(),
        best: (user.best[code] || {}).score || v.score,
        solved: !!(user.solved[code] && user.solved[code].done),
        excerpt: excerptOf(p.statement, 100)
      });
    }
    out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return send(res, 200, { ok: true, total: out.length, items: out });
  }

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

  /* ---- AI 补全帖子标题 ---- */
  /* 投稿：题干 → AI 补全整条记录（标题/考点/三维评分/提示/答案/解析） */
  if ((pathname === '/api/ai/suggest-meta' || pathname === '/api/ai/complete-problem') && method === 'POST') {
    if (!user) return fail(res, 401, '请先登录');
    const body = await readBody(req);
    const st = String(body.statement || '').trim();
    if (st.length < 8) return fail(res, 400, '题干太短，先识别或写几行再补全');
    const full = pathname === '/api/ai/complete-problem';
    const sys = {
      role: 'system',
      content: [
        '你是数学题库编辑。给你一道题的题干，补全它在题库里需要的元信息。',
        '',
        '规则：',
        '1. 标题 ≤18 字，说清「考什么方法 / 什么对象」，不带题号，不要「求解」「计算题」这类空话；',
        '2. 考点 1-3 个名词短语，用顿号分隔；',
        '3. 三维评分各 1-10 的整数：思维量=想到方法的难度（套公式 3-4，需构造 7-9）、难度=综合难度、计算量=算到底的工作量；',
        '4. 分层提示 1-3 条，每条一句话，第一句只给方向、不直接给答案；',
        full ? '5. 最终答案要精确（LaTeX，行内用 $...$）；完整解析分步写清思路与关键计算，不要只写答案；' : '5. 不要写答案和解析；',
        '6. 认不出来的地方写 $\\square$，不要编造数字；',
        '',
        '严格按下面的段输出，不要解释、不要代码块：',
        '[TITLE]', '[TAGS]', '[THINKING]', '[DIFFICULTY]', '[CALC]', '[HINTS]', '[ANSWER]', '[SOLUTION]'
      ].join('\n')
    };
    const userMsg = { role: 'user', content: '题干：\n' + st.slice(0, 1800) };
    for (const cfg of llmCandidates(body.llm || null)) {
      try {
        const raw = String(await callLLM(cfg, [sys, userMsg]) || '');
        const sec = (tag) => {
          const re = new RegExp('\\\\[' + tag + '\\\\]([\\\\s\\\\S]*?)(?=\\\\[[A-Z]+\\\\]|$)', 'i');
          const m = re.exec(raw);
          return m ? m[1].trim() : '';
        };
        const num = (t) => {
          const v = Number(String(t).replace(/[^0-9]/g, ''));
          return v >= 1 && v <= 10 ? v : 0;
        };
        const title = sec('TITLE').replace(/[「」""'。.]/g, '').replace(/\n.*/s, '').trim().slice(0, 40);
        const tags = sec('TAGS').split(/[、,，;；\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 3);
        const out = {
          ok: true, by: cfg.name, title, tags,
          thinking: num(sec('THINKING')), difficulty: num(sec('DIFFICULTY')), calc: num(sec('CALC')),
          hints: sec('HINTS').split(/\n+/).map((x) => x.replace(/^[-*·\d.、\s]+/, '').trim()).filter(Boolean).slice(0, 5),
          answer: full ? sec('ANSWER').trim() : '',
          solution: full ? sec('SOLUTION').trim() : ''
        };
        if (title || tags.length || out.hints.length) return send(res, 200, out);
      } catch (e) { /* 换下一个通道 */ }
    }
    return fail(res, 502, '暂时连不上模型，可以手动填');
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

  /* ---- 组卷：按考研题型结构随机抽题 ---- */
  if (pathname === '/api/paper/generate' && method === 'POST') {
    const body = await readBody(req);
    const spec = {
      choice: Math.max(0, Math.min(20, Number(body.choice !== undefined ? body.choice : 10))),
      fill: Math.max(0, Math.min(20, Number(body.fill !== undefined ? body.fill : 6))),
      solution: Math.max(0, Math.min(20, Number(body.solution !== undefined ? body.solution : 6))),
      tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 5) : [],
      difficulty: String(body.difficulty || '')
    };

    let pool = db.problems.filter((p) => p.status === 'approved');
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
      post.views = (post.views || 0) + 1;
      saveDb();
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

  /* ---- 投稿 ---- */
  if (pathname === '/api/submit' && method === 'POST') {
    if (!user) return fail(res, 401, '请先登录再投稿');
    const body = await readBody(req);
    const item = normalizeProblem(body);
    if (!item) return fail(res, 400, '标题和题干必填');
    item.code = nextProblemCode();
    item.authorId = user.id;
    item.authorName = user.name;
    db.problems.push(item);
    logActivity(user, '投稿 ' + item.code + ' 待审核', item.code);
    saveDb();
    return send(res, 200, { ok: true, code: item.code });
  }

  if (pathname === '/api/my/submissions' && method === 'GET') {
    if (!user) return fail(res, 401, '请先登录');
    const items = db.problems
      .filter((p) => p.authorId === user.id && p.status !== 'approved')
      .map((p) => ({ code: p.code, title: p.title, status: p.status, rejectReason: p.rejectReason, createdAt: p.createdAt }));
    return send(res, 200, { ok: true, items });
  }

  if (pathname === '/api/my/solved' && method === 'GET') {
    if (!user) return fail(res, 401, '请先登录');
    const solved = user.solved || {};
    const items = Object.keys(solved)
      .filter((code) => solved[code] && solved[code].done)
      .map((code) => {
        const p = db.problems.find((x) => x.code === code);
        return {
          code,
          title: p ? p.title : code,
          at: solved[code].at,
          revealed: !!solved[code].revealed,
          askedAI: !!solved[code].askedAI
        };
      })
      .sort((a, b) => (b.at || 0) - (a.at || 0));
    return send(res, 200, { ok: true, items });
  }

  /* 最近作答（含没通过线的），让「我的记录」能看到每次提交 */
  if (pathname === '/api/my/attempts' && method === 'GET') {
    if (!user) return send(res, 200, { ok: true, items: [] });
    const items = db.submissions
      .filter((x) => x.uid === user.id)
      .slice(-40)
      .reverse()
      .map((x) => {
        const p = db.problems.find((q) => q.code === x.code);
        return {
          id: x.id, code: x.code,
          title: p ? p.title : x.code,
          score: x.score, verdict: x.verdict, mode: x.mode,
          judgedBy: x.judgedBy || '', at: x.at,
          comment: String(x.comment || '').slice(0, 120)
        };
      });
    return send(res, 200, { ok: true, items });
  }

  /* ---- 管理端 ---- */
  if (pathname.startsWith('/api/admin/')) {
    if (!user || user.role !== 'admin') return fail(res, 403, '需要管理员权限');

    if (pathname === '/api/admin/pending' && method === 'GET') {
      const items = db.problems.filter((p) => p.status === 'pending').map((p) => ({
        code: p.code, title: p.title, statement: p.statement, tags: p.tags,
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
        if (Array.isArray(patch.tags) && patch.tags.length) p.tags = patch.tags.map(String).slice(0, 6);
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
        db.problems = db.problems.filter((x) => x.code !== p.code);
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
        item.code = nextProblemCode();
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
      const limit = Math.min(200, Number(query.limit || 60));
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
        feedbacks: db.feedbacks
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
        }
      });
    }

    if (pathname === '/api/admin/llm' && method === 'POST') {
      const body = await readBody(req);
      if (body.baseUrl !== undefined) {
        const normalized = safeLlmBaseUrl(body.baseUrl);
        if (!normalized) return fail(res, 400, '接口地址必须是 https，且域名在白名单内（可用 LLM_ALLOWED_HOSTS 扩展）');
        db.settings.llm.baseUrl = normalized;
      }
      if (body.model !== undefined) db.settings.llm.model = String(body.model).trim();
      if (body.apiKey !== undefined && String(body.apiKey).trim()) db.settings.llm.apiKey = String(body.apiKey).trim();
      if (body.clearKey) db.settings.llm.apiKey = '';
      // 识图通道：target='vision' 时写另一组，全站用户都能用
      if (body.target === 'vision' || body.vision) {
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
        return Object.assign(publicFeedback(f, user), { title: pr ? pr.title : '', tags: pr ? pr.tags : [] });
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

  /* ---- 排行榜 ---- */
  if (pathname === '/api/leaderboard' && method === 'GET') {
    // 全站账号都列出来（按经验、做出题数排序），不再只给前 10 名
    const all = db.users.slice()
      .map((u) => publicUser(u))
      .sort((a, b) => (b.exp - a.exp) || (b.solvedCount - a.solvedCount) || String(a.name).localeCompare(String(b.name)))
      .map((u, i) => Object.assign({ rank: i + 1 }, u));
    return send(res, 200, { ok: true, total: all.length, items: all.slice(0, 200) });
  }

  /* ---- 对话系统提示词（给浏览器直连免费通道用） ---- */
  if (pathname === '/api/ai/prompt/chat' && method === 'POST') {
    if (!user) return fail(res, 401, '登录后才能使用 AI 接口');
    const body = await readBody(req, 64 * 1024);
    const problem = body.problemCode ? db.problems.find((p) => p.code === String(body.problemCode).toUpperCase()) : null;
    const msgs = llmMessages(problem, [], { expert: body.expert !== false });
    return send(res, 200, { ok: true, system: msgs[0].content });
  }

/* ------------------------------------------------------- 答案判题 */

function canonAnswer(src) {
  let t = String(src || '').toLowerCase();
  t = t.replace(/\$\$?/g, ' ');
  t = t.replace(/\\left|\\right/g, '');
  t = t.replace(/\\[dt]frac/g, '\\frac');
  t = t.replace(/\\displaystyle|\\textstyle|\\limits/g, '');
  t = t.replace(/\\[,;:! ]/g, '');
  t = t.replace(/\\mathrm\{d\}|\\text\{d\}/g, 'd');
  t = t.replace(/\\mathrm|\\text|\\operatorname/g, '');
  t = t.replace(/\\arcsin|\\asin/g, 'arcsin');
  t = t.replace(/\\arctan|\\atan/g, 'arctan');
  t = t.replace(/\\ln/g, 'ln');
  t = t.replace(/\\pi/g, 'π');
  t = t.replace(/\s+/g, '');
  t = t.replace(/\+c\.?$/, '');
  t = t.replace(/[。.,]$/, '');
  return t;
}

function numericValue(s) {
  const t = String(s || '').replace(/\s+/g, '').replace(/^=|=$/g, '');
  let m = /^\\?[dt]?frac\{(-?[\d.]+)\}\{(-?[\d.]+)\}$/.exec(t);
  if (m) return Number(m[1]) / Number(m[2]);
  m = /^(-?[\d.]+)\/(-?[\d.]+)$/.exec(t);
  if (m) return Number(m[1]) / Number(m[2]);
  if (/^-?[\d.]+$/.test(t)) return Number(t);
  return null;
}

function answersEquiv(student, expected) {
  if (!student) return false;
  const a = canonAnswer(student);
  const b = canonAnswer(expected);
  if (!a || !b) return false;
  if (a === b) return true;
  const na = numericValue(a);
  const nb = numericValue(b);
  if (na !== null && nb !== null) return Math.abs(na - nb) < 1e-9;
  return false;
}

/* 只认结论行：末行，或带「综上/故/所以/答案/最终/结果」标记的行。
   旧实现扫全文所有数字，过程里出现「第 1 步」而答案恰好是 1 就会误判。 */
function conclusionSegments(process) {
  const lines = String(process || '').split(/[\r\n]+|[。；;]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  if (!lines.length) return [];
  const mark = /综上|故|所以|因此|答案|最终|结果|答[:：]|结论|=>/;
  const out = lines.filter(function (x) { return mark.test(x); });
  out.push(lines[lines.length - 1]);
  return out.filter(function (x, i) { return out.indexOf(x) === i; });
}

function processMatchesAnswer(process, expected) {
  if (!process || !expected) return false;
  if (answersEquiv(process, expected)) return true;
  const targetText = canonAnswer(expected);
  if (!targetText) return false;
  const targetNum = numericValue(targetText);
  const marker = /综上|故|所以|因此|答案(?:是)?[:：]?|最终(?:结果)?(?:是)?[:：]?|结果(?:是)?[:：]?|答[:：]|结论[:：]?|=>/;
  for (const line of conclusionSegments(process)) {
    if (answersEquiv(line, expected)) return true;
    const candidates = [];
    // 只认显式答案形态：$...$、= 数值、等于/答案是/结果为 数值；不再扫全文裸数字
    (line.match(/\$[^$]+\$/g) || []).forEach(function (x) { candidates.push(x); });
    const lead = /(?:[=＝≈]|等于|答案是|结果是|结果为|最终(?:结果)?(?:是|为)?|得到|得)\s*([^，。；;,]+)/g;
    let m;
    while ((m = lead.exec(line)) !== null) candidates.push(m[1]);
    if (marker.test(line)) candidates.push(line.split(marker).pop());
    for (const cand of candidates) {
      const c = canonAnswer(cand);
      if (!c) continue;
      if (c === targetText) return true;
      const n = numericValue(c);
      if (targetNum !== null && n !== null && Math.abs(n - targetNum) < 1e-9) return true;
      // 文字型答案（如「条件收敛」）：只在不含数字时允许作为结论子串出现
      if (targetNum === null && targetText.length >= 2 && c.indexOf(targetText) >= 0) return true;
    }
  }
  return false;
}

const VISION_MODEL = /gpt-4o|gpt-4\.1|o3|o4|claude|gemini|qwen.*vl|glm-4v|vision|llava|internvl/i;

function judgeMessages(problem, process, hasImage, opts) {
  opts = opts || {};
  const sys = [
    '你是高等数学阅卷老师，学生交的可能是完整过程，也可能只有最终答案，你要逐步核对并打分。',
    '',
    '严格按分段格式输出，不要用 JSON、不要代码块、不要额外解释：',
    '',
    '[VERDICT]',
    'correct / partial / wrong 三选一',
    '[SCORE]',
    '0-100 的整数',
    '[COMMENT]',
    '2-4 句总评：思路对不对、方法是否最优、哪一步是决定性的',
    '[ERRORS]',
    '每行一条，格式：位置｜原因',
    '没有错误就写：无',
    '',
    '打分尺度（2026-11-25 起）：',
    '1. 最终答案正确，且写了任何思路或过程（哪怕只有一两句、中间跳步、省略验算）→ verdict=correct，score=100；不要因跳步、步骤不完整、不够严谨扣分；',
    '2. 只交最终答案、完全没有过程 → 即便答案正确也最高 80 分，verdict=partial，并在 [COMMENT] 里说明「缺少思路」；',
    '3. 最终答案错误 → 按错误程度给 0-79，verdict=wrong / partial；过程再完整也不能判 correct；',
    '4. 完全不着边 → 0-19。',
    '',
    '其它要求：',
    '- 答案正确时 [ERRORS] 写「无」，不要列举跳步或省略步骤的问题；',
    '- 答案错误时，错误要具体到「第几步、把什么写成了什么」，不要只说「计算有误」；',
    '- 公式用 $...$ 写；只评价，不要重写整份解答；',
    '- 如果给了「之前的提交记录」，要指出这次比上次好在哪、问题是否还在。'
  ].join('\n');

  const parts = [
    '题目：' + problem.statement,
    '标准解答：' + (problem.solution || '(未录入解析)'),
    '标准答案：' + (problem.answer || '(未录入)')
  ];

  if (Array.isArray(opts.history) && opts.history.length) {
    parts.push('之前的提交记录（按时间从早到晚，本次是第 ' + (opts.history.length + 1) + ' 次提交）：');
    opts.history.forEach(function (h, i) {
      parts.push('第' + (i + 1) + '次：得分 ' + h.score + '，判定 ' + h.verdict +
        (h.comment ? '，总评「' + String(h.comment).slice(0, 80) + '」' : '') +
        (h.errors && h.errors.length ? '，错误「' + String(h.errors[0]).slice(0, 60) + '」' : ''));
    });
  }

  parts.push(opts.answerOnly ? '学生只交了最终答案（没有过程）：' + (process || '(见图片)') : '学生提交的解题过程：' + (process || '(见图片)'));

  return [
    { role: 'system', content: sys },
    { role: 'user', content: parts.join('\n\n') }
  ];
}

function parseJudge(text) {
  const KEYMAP = { VERDICT: 'verdict', SCORE: 'score', COMMENT: 'comment', ERRORS: 'errors' };
  const t = String(text || '').replace(/\r/g, '');
  const re = /^[ \t>*#-]*\[(VERDICT|SCORE|COMMENT|ERRORS)\][ \t:：]*$/gim;
  const marks = [];
  let m;
  while ((m = re.exec(t)) !== null) marks.push({ key: KEYMAP[m[1].toUpperCase()], start: m.index, bodyStart: re.lastIndex });

  if (marks.length) {
    const obj = { errors: [] };
    for (let i = 0; i < marks.length; i++) {
      const cur = marks[i];
      const stop = i + 1 < marks.length ? marks[i + 1].start : t.length;
      const body = t.slice(cur.bodyStart, stop).trim();
      if (cur.key === 'verdict') {
        const v = body.toLowerCase();
        obj.verdict = /correct|完全正确/.test(v) ? 'correct' : (/partial|部分/.test(v) ? 'partial' : (/wrong|错误|不对/.test(v) ? 'wrong' : 'unclear'));
      } else if (cur.key === 'score') {
        const n = body.match(/\d+/);
        obj.score = n ? Math.max(0, Math.min(100, Number(n[0]))) : undefined;
      } else if (cur.key === 'comment') {
        obj.comment = body;
      } else {
        obj.errors = body.split('\n')
          .map((x) => x.replace(/^\s*(\d+[.、)]|[-*·•])\s*/, '').trim())
          .filter((x) => x && !/^(无|none|没有|没有错误)[。.]?$/i.test(x));
      }
    }
    if (obj.verdict) {
      if (obj.score === undefined) obj.score = obj.verdict === 'correct' ? 100 : (obj.verdict === 'partial' ? 60 : 20);
      return obj;
    }
  }

  // 兜底：没有分段结构就按关键词粗判
  const plain = String(text || '');
  let verdict = 'unclear';
  if (/完全正确|答案正确|\bcorrect\b/i.test(plain)) verdict = 'correct';
  else if (/部分正确|\bpartial\b/i.test(plain)) verdict = 'partial';
  else if (/不正确|错误|\bwrong\b/i.test(plain)) verdict = 'wrong';
  return { verdict, score: verdict === 'correct' ? 100 : (verdict === 'partial' ? 60 : 20), comment: plain.replace(/\s+/g, ' ').slice(0, 220), errors: [] };
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
    const raw = parseGenerated(out) || extractJson(out);
    const item = validateGenerated(raw);
    if (!item) return send(res, 200, { ok: true, needVision: false, parsed: false, prompt: OCR_PROMPT, raw: String(out).slice(0, 800) });
    return send(res, 200, { ok: true, problem: item, model: { provider: used.name, model: used.model } });
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

  if (pathname === '/api/admin/ocr-badcases' && method === 'GET') {
    if (!user || user.role !== 'admin') return fail(res, 403, '需要管理员权限');
    const list = (db.ocrBadcases || []).slice(-200).reverse();
    return send(res, 200, { ok: true, total: (db.ocrBadcases || []).length, items: list });
  }

  /* ---- 出题提示词（给浏览器直连免费通道用） ---- */
  if (pathname === '/api/ai/prompt' && method === 'POST') {
    if (!user) return fail(res, 401, '登录后才能使用 AI 接口');
    const body = await readBody(req, 64 * 1024);
    const spec = {
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

  return fail(res, 404, '接口不存在');
}

/* ------------------------------------------------------------- 静态资源 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
};

/* 上传的图片落盘到 data/uploads，URL 记在库里 */
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

function saveUpload(dataUrl) {
  try {
    const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(dataUrl);
    if (!m) return '';
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 4 * 1024 * 1024) return '';
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

function serveUpload(res, pathname) {
  const name = path.basename(pathname);
  if (!/^[A-Za-z0-9]+\.(png|jpg|jpeg|webp|gif)$/i.test(name)) return fail(res, 404, '图片不存在');
  const file = path.join(UPLOAD_DIR, name);
  fs.readFile(file, (err, data) => {
    if (err) return fail(res, 404, '图片不存在');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400'
    });
    res.end(data);
  });
}

function serveStatic(req, res, pathname) {
  if (pathname.indexOf('/uploads/') === 0) return serveUpload(res, pathname);
  // 非法百分号编码（如 /%zz）会让 decodeURIComponent 抛 URIError；
  // 这里曾经在 try/catch 之外，一个匿名请求就能把进程打死。
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {
    return fail(res, 400, '请求路径编码不合法');
  }
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return fail(res, 403, '禁止访问');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (req.headers.accept && req.headers.accept.includes('text/html')) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) return fail(res, 404, '页面不存在');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(html);
        });
      }
      return fail(res, 404, '资源不存在');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(data);
  });
}

/* --------------------------------------------------------------- 启动 */

const server = http.createServer(async (req, res) => {
 try {
  const parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams.entries());

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, pathname, query);
    } catch (e) {
      console.error('[api]', pathname, e);
      if (!res.headersSent) fail(res, 500, e.message || '服务器内部错误');
      else try { res.end(); } catch (_) {}
    }
    return;
  }

  serveStatic(req, res, pathname);
 } catch (e) {
   console.error('[http] 未捕获异常:', req.method, req.url, (e && e.stack) || e);
   try {
     if (!res.headersSent) fail(res, 500, '服务器内部错误');
     else res.end();
   } catch (e2) {}
 }
});

// 最后一道兜底：任何漏网的异常都不许把进程带走
process.on('uncaughtException', (e) => { console.error('[uncaught]', (e && e.stack) || e); });
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', (e && e.stack) || e); });

loadDb();

server.listen(PORT, HOST, () => {
  console.log(SITE_NAME + ' running at http://localhost:' + PORT);
  console.log('题目数:', db.problems.filter((p) => p.status === 'approved').length, '| 用户数:', db.users.length, '| LLM:', llmConfigured() ? db.settings.llm.model : '本地讲解模式');
});

process.on('SIGINT', () => { saveDb(true); process.exit(0); });
process.on('SIGTERM', () => { saveDb(true); process.exit(0); });
