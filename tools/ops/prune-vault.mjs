#!/usr/bin/env node
/**
 * 题库整理：删天文 / 合并「只换数据」的相似题 / 隐藏测试账号
 *
 * 用法：
 *   node tools/ops/prune-vault.mjs astro            # 删除天文题
 *   node tools/ops/prune-vault.mjs dedupe           # 合并物理相似题（同骨架只留一题）
 *   node tools/ops/prune-vault.mjs hide-test-users  # 隐藏测试账号（保留数据，不参与榜单）
 *   node tools/ops/prune-vault.mjs purge-refs       # 清掉指向已删除题目的提交/进度引用
 *   node tools/ops/prune-vault.mjs all
 *   任意子命令加 --dry 只报告不写盘
 *
 * 三条约定：
 *   1. 所有被删/被合并的题目都先写进归档：`<workspace>/_archive/vault-cleanup/<时间戳>/`。
 *      归档目录在 amv-phys 之外，不会随发布上传，也不占仓库体积。
 *   2. 科目包（data/subjects/*.json）里引用到的题目编号一律不删——否则期末突击会缺题。
 *   3. 写盘走 临时文件 + rename，与 lib/core.js#writeDbFile 的原子写保持一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');            // amv-phys
const WORKSPACE = path.join(ROOT, '..');                   // 43
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const PACK_DIR = path.join(ROOT, 'data', 'subjects');
const ARCHIVE_ROOT = path.join(WORKSPACE, '_archive', 'vault-cleanup');

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const cmd = argv.find((a) => !a.startsWith('--')) || 'all';
/* 每个相似组保留几题：默认 1（真正合并成一道）。
   想保留同题型的多种数据（例如 5 道不同参数的卫星题），传 --keep 5。 */
const keepArg = argv.indexOf('--keep');
const KEEP = keepArg >= 0 ? Math.max(1, Number(argv[keepArg + 1]) || 1) : 1;

const ASTRONOMY_MAINS = ['球面天文与天体力学', '天体物理基础'];
const TEST_USER_RE = /^(vtest|vt|vw|gz)\d+$/i;

function readDb() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDb(db) {
  if (dry) return;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function archive(tag, payload) {
  if (dry) return '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(ARCHIVE_ROOT, stamp);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, tag + '.json');
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

/** 科目包里引用到的编号，这些题不许删 */
function protectedCodes() {
  const out = new Set();
  try {
    for (const f of fs.readdirSync(PACK_DIR)) {
      if (!f.endsWith('.json')) continue;
      const pack = JSON.parse(fs.readFileSync(path.join(PACK_DIR, f), 'utf8'));
      const walk = (v) => {
        if (!v) return;
        if (Array.isArray(v)) return v.forEach(walk);
        if (typeof v === 'object') {
          if (typeof v.ref === 'string') out.add(v.ref.toUpperCase());
          if (typeof v.code === 'string' && /^(PH|HS)\d+$/.test(v.code)) out.add(v.code.toUpperCase());
          return Object.values(v).forEach(walk);
        }
      };
      walk(pack);
    }
  } catch (e) { /* 没有科目包目录就当作没有保护项 */ }
  return out;
}

/** 题面骨架：抹掉所有数字与单位，只留「问什么、怎么问」 */
function skeleton(text) {
  return String(text || '')
    .replace(/\$[^$]*\$/g, (m) => m)                 // 保留公式结构，下面统一抹数字
    .replace(/\\[a-zA-Z]+/g, ' ')                    // 去掉 \mathrm \frac 等命令名
    .replace(/\d+(?:\.\d+)?/g, '#')                  // 数字 → #
    .replace(/[{}[\]]/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

/* ------------------------------------------------------------ 三个动作 */

function doAstro(db) {
  const keep = [];
  const gone = [];
  for (const p of db.problems) {
    const isAstro = p.subject === 'physics' && (
      ASTRONOMY_MAINS.includes(p.mainTag) ||
      (p.physicsMeta && p.physicsMeta.course === 'astro'));
    (isAstro ? gone : keep).push(p);
  }
  if (!gone.length) { console.log('[astro] 没有需要删除的天文题'); return db; }
  const file = archive('astro', {
    at: new Date().toISOString(), action: 'delete-astronomy', count: gone.length, items: gone
  });
  db.problems = keep;
  console.log('[astro] 删除 ' + gone.length + ' 题（' + gone.map((p) => p.code).join(', ') + '）'
    + (file ? '\n        归档 → ' + path.relative(WORKSPACE, file) : '（--dry，未写盘）'));
  return db;
}

function doDedupe(db) {
  const prot = protectedCodes();
  const physics = db.problems.filter((p) => p.subject === 'physics');
  const groups = new Map();
  for (const p of physics) {
    const sk = skeleton(p.statement);
    if (sk.length < 24) continue;                     // 骨架太短不可信，不参与合并
    const key = p.mainTag + '|' + (p.kind || '') + '|' + sk;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const drop = new Set();
  let clusters = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    clusters++;
    /* 保留优先级：科目包引用 > 解析最完整 > 提示最多 > 编号最小 */
    const score = (p) => [
      prot.has(String(p.code).toUpperCase()) ? 1 : 0,
      (p.solution || '').length,
      (p.hints || []).length,
      -Number(String(p.code).replace(/\D/g, '') || 0)
    ];
    const sorted = list.slice().sort((a, b) => {
      const sa = score(a), sb = score(b);
      for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
      return 0;
    });
    for (const p of sorted.slice(KEEP)) drop.add(p.code);
  }

  /* 科目包引用的题绝不删（即使被判定为重复），否则期末突击会缺题 */
  for (const code of drop) if (prot.has(String(code).toUpperCase())) drop.delete(code);

  const gone = db.problems.filter((p) => drop.has(p.code));
  if (!gone.length) { console.log('[dedupe] 没有可合并的相似题'); return db; }
  const file = archive('dedupe', {
    at: new Date().toISOString(), action: 'merge-duplicate-physics',
    clusters, count: gone.length, items: gone
  });
  db.problems = db.problems.filter((p) => !drop.has(p.code));
  const byMain = {};
  for (const p of gone) byMain[p.mainTag] = (byMain[p.mainTag] || 0) + 1;
  console.log('[dedupe] ' + clusters + ' 个相似组（每组保留 ' + KEEP + ' 题），合并掉 ' + gone.length + ' 题');
  console.log('         ' + Object.entries(byMain).map(([k, v]) => k + ' -' + v).join('、'));
  if (file) console.log('         归档 → ' + path.relative(WORKSPACE, file));
  return db;
}

function doPurgeRefs(db) {
  const codes = new Set(db.problems.map((p) => p.code));
  let subs = 0, users = 0, acts = 0;
  const before = (db.submissions || []).length;
  db.submissions = (db.submissions || []).filter((x) => codes.has(x.code));
  subs = before - db.submissions.length;
  for (const u of db.users) {
    for (const k of ['solved', 'wrong', 'best']) {
      if (!u[k]) continue;
      for (const c of Object.keys(u[k])) {
        if (!codes.has(c)) { delete u[k][c]; users++; }
      }
    }
    if (Array.isArray(u.activity)) {
      const n0 = u.activity.length;
      u.activity = u.activity.filter((a) => !a.code || codes.has(a.code));
      acts += n0 - u.activity.length;
    }
  }
  if (!subs && !users && !acts) { console.log('[refs] 没有悬空引用'); return db; }
  console.log('[refs] 清掉悬空引用：提交 ' + subs + ' 条、用户进度字段 ' + users + ' 个、动态 ' + acts + ' 条');
  return db;
}

function doHideUsers(db) {
  const touched = [];
  for (const u of db.users) {
    if (u.role === 'admin') continue;                 // 管理员账号照常显示（也不算测试号）
    if (TEST_USER_RE.test(String(u.name || ''))) {
      u.hidden = true;
      touched.push(u.name);
    }
  }
  if (!touched.length) { console.log('[users] 没有需要隐藏的测试账号'); return db; }
  const file = archive('test-users', {
    at: new Date().toISOString(), action: 'hide-test-users',
    names: touched,
    snapshot: db.users.filter((u) => touched.includes(u.name))
  });
  console.log('[users] 隐藏 ' + touched.length + ' 个测试账号：' + touched.join('、')
    + (file ? '\n        归档 → ' + path.relative(WORKSPACE, file) : '（--dry，未写盘）'));
  return db;
}

/* ---------------------------------------------------------------- 入口 */

const db = readDb();
const before = db.problems.length;
const run = (name) => ({
  astro: doAstro, dedupe: doDedupe, 'hide-test-users': doHideUsers, 'purge-refs': doPurgeRefs
}[name]);
const list = cmd === 'all' ? ['astro', 'dedupe', 'hide-test-users', 'purge-refs'] : [cmd];
for (const name of list) {
  if (!run(name)) {
    console.error('未知子命令：' + name + '（可选 astro / dedupe / hide-test-users / all）');
    process.exit(1);
  }
  run(name)(db);
}
writeDb(db);
const ph = db.problems.filter((p) => p.subject === 'physics').length;
console.log('\n题库 ' + before + ' → ' + db.problems.length + ' 题（物理 ' + ph + '）'
  + (dry ? '　--dry：未写盘' : '　已写盘 ' + path.basename(DB_FILE)));
