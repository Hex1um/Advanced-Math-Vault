#!/usr/bin/env node
/**
 * 题库回流：把线上审核通过的题脱敏导出成仓库里的 data/batch-*.json
 *
 *   node tools/ops/export-batch.mjs                    # 只报告：有多少新题、会写成哪个文件
 *   node tools/ops/export-batch.mjs --write            # 真正写文件
 *   node tools/ops/export-batch.mjs --min 1 --write    # 至少 1 道新题就写
 *   node tools/ops/export-batch.mjs --sqlite data/db.sqlite --write
 *
 * 为什么需要：线上库（审核后的题）与仓库公开题库长期割裂，重装/换机就只剩
 * 公开的那部分；而且线上库里有作者、审核人、做题统计这些不该公开的字段。
 * 这里按「标题 + 题干」去重，只导出题本体，作者统一写成「题库组」。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
};

const DB_FILE = path.resolve(flag('json', process.env.DB_FILE || path.join(ROOT, 'data', 'db.json')));
const SQLITE_FILE = path.resolve(flag('sqlite', DB_FILE.replace(/\.json$/i, '') + '.sqlite'));
const WRITE = argv.includes('--write');
const MIN = Math.max(1, Number(flag('min', 1)));
const DATA_DIR = path.join(ROOT, 'data');

function loadDb() {
  if (fs.existsSync(SQLITE_FILE) && !fs.existsSync(DB_FILE)) {
    const { createStore } = require(path.join(ROOT, 'lib', 'store.js'));
    const store = createStore({ engine: 'sqlite', dbFile: DB_FILE, sqliteFile: SQLITE_FILE, mirrorJson: false });
    store.open();
    return store.load() || {};
  }
  if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return null;
}

const db = loadDb();
if (!db) {
  console.error('✗ 找不到库文件：' + DB_FILE + ' / ' + SQLITE_FILE);
  process.exit(2);
}

function fingerprint(p) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha1').update(norm(p.title) + '\u0000' + norm(p.statement)).digest('hex');
}

/* 已有公开题库的指纹 */
const published = new Set();
let batchFiles = 0;
let maxBatch = 0;
for (const f of fs.readdirSync(DATA_DIR).filter((x) => /^batch-.*\.json$/.test(x)).sort()) {
  batchFiles++;
  const m = /^batch-(\d+)\.json$/.exec(f);
  if (m) maxBatch = Math.max(maxBatch, Number(m[1]));
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch (e) { continue; }
  for (const p of Array.isArray(arr) ? arr : []) published.add(fingerprint(p));
}

const CLEAN = ['title', 'statement', 'mainTag', 'tags', 'kind', 'thinking', 'difficulty', 'calc', 'source', 'hints', 'answer', 'solution', 'createdAt'];

const approved = (db.problems || []).filter((p) => p.status === 'approved');
const fresh = [];
let duplicated = 0;
for (const p of approved) {
  if (published.has(fingerprint(p))) { duplicated++; continue; }
  const out = {};
  for (const k of CLEAN) {
    if (p[k] === undefined) continue;
    if (k === 'tags' && !Array.isArray(p[k])) continue;
    out[k] = p[k];
  }
  out.status = 'approved';
  out.authorName = '题库组';
  fresh.push(out);
}

console.log('线上题目 ' + approved.length + ' 道；公开题库 ' + published.size + ' 道（' + batchFiles + ' 个 batch 文件）');
console.log('已公开的重复题 ' + duplicated + ' 道，新增 ' + fresh.length + ' 道');

const byTag = {};
for (const p of fresh) byTag[p.mainTag || '综合'] = (byTag[p.mainTag || '综合'] || 0) + 1;
if (fresh.length) console.log('新增题按主标签: ' + Object.entries(byTag).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(' · '));

if (!WRITE) {
  console.log('\n（未写盘）确认无误后加 --write；将写入 data/batch-' + String(maxBatch + 1).padStart(2, '0') + '.json');
  process.exit(0);
}
if (fresh.length < MIN) {
  console.log('\n新题不足 ' + MIN + ' 道，不生成文件');
  process.exit(0);
}

const outFile = path.join(DATA_DIR, 'batch-' + String(maxBatch + 1).padStart(2, '0') + '.json');
if (fs.existsSync(outFile)) {
  console.error('✗ 目标文件已存在: ' + outFile);
  process.exit(2);
}
fs.writeFileSync(outFile, JSON.stringify(fresh, null, 2), 'utf8');
console.log('\n已写入 ' + outFile + '（' + fresh.length + ' 道）');
console.log('下一步：node tools/import/import-problems.mjs ' + path.relative(ROOT, outFile).replace(/\\/g, '/') + '（或提交到仓库）');
