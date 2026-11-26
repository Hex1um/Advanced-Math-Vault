#!/usr/bin/env node
/**
 * 批量导入题目
 *
 * 用法：
 *   1) 直接写库（服务需先停止）：
 *      node tools/import/import-problems.mjs data/batch-01.json
 *
 *   2) 通过 HTTP 接口导入（服务运行中，需要管理员账号）：
 *      node tools/import/import-problems.mjs data/batch-01.json --url http://localhost:8787 --user 管理员 --pass 密码
 *
 *   3) 带入库门禁（推荐）：先跑积分/极限符号校验，再给判不了的题打 needsReview
 *      node tools/import/import-problems.mjs data/batch-01.json --verify
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markList, runPythonGates, printGate } from './gate.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tagTax = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tag-taxonomy.js'));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');

const argv = process.argv.slice(2);
const file = argv[0];
if (!file) {
  console.error('用法: node tools/import/import-problems.mjs <题目.json> [--url http://localhost:8787 --user 名 --pass 密码]');
  process.exit(1);
}
const flag = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
};

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

const abs = path.resolve(process.cwd(), file);
if (!fs.existsSync(abs)) die('找不到文件: ' + abs);

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
} catch (e) {
  die('JSON 解析失败: ' + e.message);
}
const list = Array.isArray(parsed) ? parsed : parsed.problems;
if (!Array.isArray(list)) die('文件内容必须是数组，或 { "problems": [...] }');

const clamp = (v, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : d;
};


/* 与 server.js 同源的质量门禁：可疑点打到 qualityWarn，不阻断入库 */
const EXISTING = [];

function qualityGate(item, existing) {
  const warns = [];
  const st = String(item.statement || '');
  if (((st.match(/\$/g) || []).length) % 2) warns.push('定界符不配对（$ 个数为奇数）');
  const bare = st.replace(/\$\$[\s\S]*?\$\$/g, '').replace(/\$[^$]*\$/g, '');
  if (/\\[a-zA-Z]{2,}/.test(bare)) warns.push('正文含未包 $ 的 LaTeX 命令');
  if (/答\s*案\s*[：:]|解\s*[：:]/.test(st)) warns.push('题干疑似含答案/解答');
  if (/\\begin\{tasks\}|\\begin\{tabular\}|<table/i.test(st)) warns.push('残留题目环境或 HTML 表格');
  if (Array.isArray(existing) && item.title && existing.some((x) => x.title === item.title)) warns.push('标题与库内已有题目重复');
  return warns;
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim();
  const statement = String(raw.statement || raw.body || '').trim();
  if (!title || !statement) return null;
  let tags = raw.tags;
  if (typeof tags === 'string') tags = tags.split(/[,，、\s]+/);
  tags = Array.isArray(tags) ? tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 6) : [];
  let hints = raw.hints;
  if (typeof hints === 'string') hints = [hints];
  hints = Array.isArray(hints) ? hints.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 5) : [];
  /* 学科：物理题必须显式带 subject:"physics"，其余一律按数学处理。
     mainTag/子标签按对应学科体系归一化，避免物理题被数学规则吞掉。 */
  const subject = tagTax.subjectOf(raw.subject);
  const tagInfo = tagTax.normalize(tags.length ? tags : [], raw.mainTag, subject);
  const item = {
    subject,
    title: title.slice(0, 120),
    statement,
    mainTag: tagInfo.mainTag,
    tags: tagInfo.tags.length ? tagInfo.tags : (tags.length ? tags : ['未分类']),
    kind: String(raw.kind || tagInfo.kind || ''),
    thinking: clamp(raw.thinking, 6),
    difficulty: clamp(raw.difficulty, 6),
    calc: clamp(raw.calc !== undefined ? raw.calc : raw.calculation, 5),
    source: String(raw.source || '').slice(0, 80),
    hints,
    answer: String(raw.answer || '').trim(),
    solution: String(raw.solution || '').trim(),
    status: 'approved',
    authorId: null,
    authorName: String(raw.authorName || '题库组'),
    rejectReason: '',
    createdAt: raw.createdAt || new Date().toISOString(),
    reviewedAt: new Date().toISOString(),
    solvedCount: 0,
    attemptCount: 0
  };
  if (subject === 'physics' && raw.physicsMeta && typeof raw.physicsMeta === 'object') {
    /* 白名单字段：导入脚本只做形状校验，详细清洗由服务端 normalizeProblem 负责 */
    item.physicsMeta = {
      answerType: String(raw.physicsMeta.answerType || 'symbolic'),
      unit: String(raw.physicsMeta.unit || ''),
      dimension: Array.isArray(raw.physicsMeta.dimension) ? raw.physicsMeta.dimension.slice(0, 7).map(Number) : null,
      tolRel: Number.isFinite(Number(raw.physicsMeta.tolRel)) ? Number(raw.physicsMeta.tolRel) : 0.02,
      sigFigs: Number(raw.physicsMeta.sigFigs) || null,
      constants: Array.isArray(raw.physicsMeta.constants) ? raw.physicsMeta.constants.map(String).slice(0, 8) : [],
      methods: Array.isArray(raw.physicsMeta.methods) ? raw.physicsMeta.methods.map(String).slice(0, 5) : [],
      diagrams: Array.isArray(raw.physicsMeta.diagrams) ? raw.physicsMeta.diagrams.slice(0, 6) : []
    };
  }
  const warns = qualityGate(item, EXISTING);
  if (warns.length) item.qualityWarn = warns;
  return item;
}

/* 先读现有题库标题，供「标题重复」门禁用 */
try {
  if (fs.existsSync(DB_FILE)) {
    const cur = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    for (const p of cur.problems || []) EXISTING.push({ code: p.code, title: p.title });
  }
} catch (e) { console.warn('读取现有题库失败，标题查重跳过:', e.message); }

const items = [];
const skipped = [];
for (const raw of list) {
  const n = normalize(raw);
  if (!n) skipped.push(String((raw && raw.title) || '无标题'));
  else items.push(n);
}

/* --verify：先过硬门禁，再给「自动验算不了」的题打标 */
const VERIFY = argv.includes('--verify');
if (VERIFY) {
  const gate = runPythonGates();
  printGate(gate);
  if (!gate.ok) die('符号/数值自检未通过（积分/极限校验有 FAIL），已中止导入');
  const stats = markList(items);
  console.log('入库门禁：共 ' + stats.total + ' 题，需人工复核 ' + stats.flagged + ' 题');
  for (const [reason, n] of Object.entries(stats.reasons).sort((a, b) => b[1] - a[1])) {
    console.log('  · ' + reason + '：' + n);
  }
}

async function viaApi(baseUrl, user, pass) {
  const base = baseUrl.replace(/\/+$/, '');
  const loginRes = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: user, password: pass })
  });
  const login = await loginRes.json();
  if (!login.ok) die('登录失败: ' + login.error);
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];

  const res = await fetch(base + '/api/admin/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ problems: list })
  });
  const out = await res.json();
  if (!out.ok) die('导入失败: ' + out.error);
  return { added: out.added, skipped: out.skipped };
}

function direct() {
  if (!fs.existsSync(DB_FILE)) die('找不到 ' + DB_FILE + '，先启动一次服务以初始化数据库');
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db.problems = db.problems || [];
  db.meta = db.meta || { seq: 1001, postSeq: 1, replySeq: 1 };
  const added = [];
  for (const item of items) {
    /* 编号前缀按学科：数学 HS、物理 PH */
    const prefix = (tagTax.SUBJECTS[tagTax.subjectOf(item.subject)] || {}).codePrefix || 'HS';
    let code;
    do { code = prefix + db.meta.seq++; } while (db.problems.some((p) => p.code === code));
    db.problems.push(Object.assign({ code }, item));
    added.push(code);
  }
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  return { added, skipped };
}

const url = flag('url');
const result = url
  ? await viaApi(url, flag('user', ''), flag('pass', ''))
  : direct();

console.log('导入完成');
console.log('  新增 ' + result.added.length + ' 题: ' + (result.added.join(', ') || '—'));
if (result.skipped.length) console.log('  跳过 ' + result.skipped.length + ' 条（缺标题/题干）: ' + result.skipped.join(' | '));
if (!url) console.log('  已写入 ' + DB_FILE);
