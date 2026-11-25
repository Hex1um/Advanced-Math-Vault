#!/usr/bin/env node
/**
 * 题库查重：找出「同一道题被不同批次重复导入」的情况。
 *
 *   node tools/verify/dedup-problems.mjs                    # 查 data/db.json（没有则用 batch 题库）
 *   node tools/verify/dedup-problems.mjs --file x.json
 *   node tools/verify/dedup-problems.mjs --sqlite
 *   node tools/verify/dedup-problems.mjs --threshold=0.9 --json
 *   node tools/verify/dedup-problems.mjs --self-test        # 自检样本（npm run check:dedup）
 *
 * 做法：把题干规范化（去 LaTeX 排版命令、标点、空白）后切成 4-gram 字符片，
 * 用倒排索引找候选对，再算 Jaccard 相似度。纯字符级，不依赖分词，
 * 中文题干和公式混排都能用；相近的两道题会因为共享大量 4-gram 被筛出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const argv = process.argv.slice(2);
const HAS = (n) => argv.includes('--' + n);
const ARG = (n, def) => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return def;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

/** 规范化题干：只留下真正决定「是不是同一道题」的字符 */
export function normalizeForDedup(text) {
  return String(text == null ? '' : text)
    .replace(/\\left|\\right|\\displaystyle|\\limits|\\!|\\,|\\;|\\:|\\quad|\\qquad/g, '')
    .replace(/\\text\s*\{([^}]*)\}/g, '$1')
    .replace(/\\(mathrm|mathbf|mathit|operatorname)\s*\{([^}]*)\}/g, '$2')
    .replace(/[\s$\\]/g, '')
    // 注意：+ - * / = ^ _ 必须保留 —— 符号一改就是另一道题，
    // 把它们当标点删掉会让「f'+xf」和「f'-xf」变成同一个字符串（假重复）。
    .replace(/[，。、；：？！,.;:?!"'`（）()\[\]{}<>《》【】|~]/g, '')
    .toLowerCase();
}

function shingles(text, size) {
  const n = size || 4;
  const s = String(text || '');
  const out = new Set();
  if (s.length <= n) { if (s) out.add(s); return out; }
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 找出疑似重复的题对。
 * @param {Array} list 题目数组（至少要有 statement，可选 code/title/source）
 * @param {{threshold?: number, maxPairs?: number}} [opts]
 */
export function findDuplicates(list, opts) {
  const o = opts || {};
  const threshold = Number(o.threshold || 0.85);
  const maxPairs = Number(o.maxPairs || 200);

  const docs = [];
  (list || []).forEach((p, idx) => {
    const st = String((p && p.statement) || '');
    if (st.length < 12) return; // 太短的题干比不出意义
    docs.push({
      idx,
      code: (p && p.code) || '',
      title: (p && p.title) || '',
      source: (p && p.source) || '',
      key: normalizeForDedup(st),
      set: null
    });
  });

  const index = new Map();
  const POSTING_LIMIT = 120; // 太常见的片段（比如整段都是「求下列极限」）不参与配对
  for (const d of docs) {
    d.set = shingles(d.key, 4);
    for (const sh of d.set) {
      let arr = index.get(sh);
      if (!arr) { arr = []; index.set(sh, arr); }
      if (arr.length <= POSTING_LIMIT) arr.push(d.idx);
    }
  }

  const seen = new Map();
  for (const d of docs) {
    for (const sh of d.set) {
      const arr = index.get(sh);
      if (!arr || arr.length > POSTING_LIMIT) continue;
      for (const other of arr) {
        if (other <= d.idx) continue;
        const k = d.idx + ':' + other;
        seen.set(k, (seen.get(k) || 0) + 1);
      }
    }
  }

  const pairs = [];
  for (const [k, shared] of seen) {
    if (shared < 5) continue; // 至少共享 5 个 4-gram 才值得精算
    const [i, j] = k.split(':').map(Number);
    const a = docs.find((d) => d.idx === i);
    const b = docs.find((d) => d.idx === j);
    if (!a || !b) continue;
    const sim = jaccard(a.set, b.set);
    if (sim >= threshold) pairs.push({ a: a, b: b, similarity: Math.round(sim * 1000) / 1000 });
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  return {
    compared: docs.length,
    pairs: pairs.slice(0, maxPairs).map((p) => ({
      codeA: p.a.code, codeB: p.b.code,
      titleA: p.a.title, titleB: p.b.title,
      sourceA: p.a.source, sourceB: p.b.source,
      similarity: p.similarity
    }))
  };
}

/* ------------------------------------------------------------ 数据源 */
function loadProblems() {
  const sqlite = ARG('sqlite', null);
  if (sqlite !== null && sqlite !== undefined) {
    const candidates = typeof sqlite === 'string'
      ? [path.resolve(sqlite)]
      : [path.join(ROOT, 'data', 'vault.db'), path.join(ROOT, 'data', 'db.sqlite')];
    const file = candidates.find((f) => fs.existsSync(f));
    if (!file) { console.error('✗ 找不到 SQLite 库：' + candidates.join(' 或 ')); process.exit(2); }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    try {
      return db.prepare('SELECT body FROM problems ORDER BY rowid').all()
        .map((r) => { try { return JSON.parse(r.body); } catch (e) { return null; } })
        .filter(Boolean);
    } finally { try { db.close(); } catch (e) {} }
  }

  const file = ARG('file', null);
  if (file) {
    const abs = path.resolve(process.cwd(), String(file));
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.problems;
    if (!Array.isArray(list)) { console.error('✗ 文件格式不对'); process.exit(2); }
    return list;
  }

  const dbFile = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
  if (fs.existsSync(dbFile)) return JSON.parse(fs.readFileSync(dbFile, 'utf8')).problems || [];
  const dir = path.join(ROOT, 'data');
  let out = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^batch.*\.json$/.test(x)).sort()) {
    const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (Array.isArray(arr)) out = out.concat(arr);
  }
  console.error('[dedup] 未找到 data/db.json，改用 batch 题库：' + out.length + ' 题');
  return out;
}

/* ------------------------------------------------------------ 自检 */
if (HAS('self-test')) {
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
  };

  const A = '求 $\\displaystyle\\lim_{x\\to 0}\\frac{\\tan x-\\sin x}{x^{3}}$ 的值，并说明理由。';
  const B = '求 $\\lim_{x\\to 0}\\frac{\\tan x-\\sin x}{x^{3}}$ 的值，并说明理由。'; // 只差一个 \displaystyle
  const C = '计算不定积分 $\\int \\frac{\\mathrm{d}x}{x^{2}+1}$。';
  const D = '设 $f(x)=x^{3}-3x$，求其在 $[-2,2]$ 上的最大值与最小值。';

  const res = findDuplicates([
    { code: 'A1', title: '极限一', statement: A },
    { code: 'B2', title: '极限一（重复导入）', statement: B },
    { code: 'C3', title: '不定积分', statement: C },
    { code: 'D4', title: '最值', statement: D }
  ], { threshold: 0.85 });

  const hasAB = res.pairs.some((p) => (p.codeA === 'A1' && p.codeB === 'B2') || (p.codeB === 'A1' && p.codeA === 'B2'));
  ok('识别出排版差异的近重复题', hasAB, JSON.stringify(res.pairs));
  ok('不把不同题误判为重复', res.pairs.length === 1, JSON.stringify(res.pairs.map((p) => p.codeA + '-' + p.codeB)));
  ok('相似度接近 1', hasAB && res.pairs[0].similarity >= 0.85, JSON.stringify(res.pairs[0]));

  const norm = normalizeForDedup(A);
  ok('规范化去掉排版命令与标点', !/displaystyle|\\|\$|，/.test(norm), norm);
  ok('规范化保留数学内容', norm.indexOf('tanx') >= 0 || norm.indexOf('tan') >= 0, norm);

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

/* ------------------------------------------------------------ CLI */
const threshold = Number((argv.find((a) => a.startsWith('--threshold=')) || '').split('=')[1] || 0.85);
const problems = loadProblems();
const started = Date.now();
const res = findDuplicates(problems, { threshold });
const ms = Date.now() - started;

if (HAS('json')) {
  console.log(JSON.stringify(Object.assign({ threshold, ms }, res), null, 2));
} else {
  console.log('题数 ' + problems.length + ' | 参与比对 ' + res.compared + ' | 疑似重复对 ' + res.pairs.length
    + ' | 阈值 ' + threshold + ' | 耗时 ' + ms + 'ms');
  for (const p of res.pairs.slice(0, 30)) {
    console.log('  ' + p.similarity.toFixed(3) + '  ' + (p.codeA || '(无编号)') + ' ↔ ' + (p.codeB || '(无编号)')
      + '  | ' + (p.titleA || '').slice(0, 20) + ' / ' + (p.titleB || '').slice(0, 20)
      + (p.sourceA || p.sourceB ? '  [' + (p.sourceA || '?') + ' vs ' + (p.sourceB || '?') + ']' : ''));
  }
  if (res.pairs.length > 30) console.log('  … 另有 ' + (res.pairs.length - 30) + ' 对，用 --json 看全部');
}

/* 给 import-problems.mjs 复用：命中重复就退出非零，避免把重复题再导一遍 */
if (HAS('strict') && res.pairs.length) {
  console.error('✗ 发现 ' + res.pairs.length + ' 对疑似重复题，已阻止入库（--strict）');
  process.exit(1);
}
