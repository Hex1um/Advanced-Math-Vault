#!/usr/bin/env node
/**
 * 全库记号规范化：
 *   1. 矩阵统一用中括号：pmatrix -> bmatrix；\left(\begin{array}...\right) -> \left[...\right]
 *   2. 单位矩阵统一用 I：只在矩阵/线性代数语境替换 E，排除 E(X)、E(i,j)、点 E、能量 E 等
 *
 *   node tools/import/normalize-notation.mjs            # dry-run
 *   node tools/import/normalize-notation.mjs --write    # 写回 data/db.json
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB_FILE = path.join(ROOT, 'data', 'db.json');
const WRITE = process.argv.includes('--write');
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const FIELDS = ['title', 'statement', 'solution', 'answer', 'hints'];

const stats = { pmatrix: 0, parenArray: 0, identity: 0, keptE: 0, problemsChanged: 0 };
const keptSamples = [];

function matrixContext(p) {
  const text = [p.title, p.statement, p.solution, p.answer, (p.tags || []).join(' '), p.mainTag].join(' ');
  return p.mainTag === '线性代数' || /矩阵|行列式|特征值|特征向量|可逆|伴随矩阵|相似|合同|二次型|线性方程组|秩|正交矩阵|单位矩阵|单位阵/.test(text);
}

function normalizeMatrices(text) {
  let t = String(text || '');
  const p1 = (t.match(/\\begin\{pmatrix\}/g) || []).length;
  t = t.replace(/\\begin\{pmatrix\}/g, '\\begin{bmatrix}');
  t = t.replace(/\\end\{pmatrix\}/g, '\\end{bmatrix}');
  // 只有 \left( ... \right) 包起来的 array 才视为矩阵；cases 用 \left\{，不会被误伤
  const p2 = (t.match(/\\left\s*\(\s*\\begin\{array\}/g) || []).length;
  t = t.replace(/\\left\s*\(\s*\\begin\{array\}([\s\S]*?)\\end\{array\}\s*\\right\s*\)/g,
    '\\left[\\begin{array}$1\\end{array}\\right]');
  stats.pmatrix += p1;
  stats.parenArray += p2;
  return t;
}

const TOKEN = /\\mathbf\s*\{\s*E\s*\}|\\mathrm\s*\{\s*E\s*\}|\\boldsymbol\s*\{\s*E\s*\}|\\pmb\s*\{\s*E\s*\}|E(?:_\s*\{?\s*[0-9n]+\s*\}?|\^\s*\{\s*(?:-1|T|\*|\\mathrm\s*\{\s*T\s*\})\s*\})?/g;

function replaceIdentity(text, problem) {
  let t = String(text || '');
  if (!matrixContext(problem)) return t;
  const full = [problem.title, problem.statement, problem.solution, problem.answer].join(' ');
  const elementary = /初等|交换\s*\$?E_|倍加\s*\$?E_|倍乘\s*\$?E_/.test(full);
  return t.replace(TOKEN, (tok, offset, whole) => {
    const after = whole.slice(offset + tok.length);
    const next = after[0] || '';
    const before = whole.slice(Math.max(0, offset - 8), offset);
    const around = before + tok + after.slice(0, 16);

    // 期望 E(X) / E[...]，包括 E (X) 这种带空格的写法
    if (/^\s*[\(\[]/.test(after) || next === '{') {
      stats.keptE++;
      if (keptSamples.length < 20) keptSamples.push(problem.code + ' | ' + around.replace(/\n/g, ' '));
      return tok;
    }
    // 初等矩阵 E_{ij} / E(i,j)，以及被明确命名成初等变换矩阵的 E_1/E_2
    const sub = (whole.slice(offset + 1).match(/^_\s*\{?([0-9nij,]+)\}?/) || [])[1] || '';
    const tokSub = /^E_/.test(tok) ? tok : '';
    if (/[ij,]/.test(sub) || (elementary && /^E_[123]$/.test(tokSub))) {
      stats.keptE++;
      if (keptSamples.length < 20) keptSamples.push(problem.code + ' | ' + around.replace(/\n/g, ' '));
      return tok;
    }
    // 几何点 E / 能量/电场 E
    if (/点\s*\$?\s*$/.test(before) || /顶点\s*\$?\s*$/.test(before) || /能量|电场|电动势|弹性模量/.test(around)) {
      stats.keptE++;
      if (keptSamples.length < 20) keptSamples.push(problem.code + ' | ' + around.replace(/\n/g, ' '));
      return tok;
    }
    stats.identity++;
    return tok.replace(/E/, 'I');
  });
}

for (const p of db.problems) {
  let changed = false;
  for (const f of FIELDS) {
    if (p[f] === undefined || p[f] === null) continue;
    if (Array.isArray(p[f])) {
      const next = p[f].map((x) => replaceIdentity(normalizeMatrices(x), p));
      if (JSON.stringify(next) !== JSON.stringify(p[f])) { p[f] = next; changed = true; }
    } else {
      const next = replaceIdentity(normalizeMatrices(p[f]), p);
      if (next !== p[f]) { p[f] = next; changed = true; }
    }
  }
  if (changed) stats.problemsChanged++;
}

console.log(JSON.stringify(stats, null, 2));
console.log('\n保留 E 的抽样：');
for (const s of keptSamples) console.log(' ', s);
console.log('\n替换后 E→I 的抽样：');
let n = 0;
for (const p of db.problems) {
  for (const f of ['statement', 'solution', 'answer']) {
    if (n >= 10) break;
    const v = p[f] || '';
    const i = v.indexOf('I');
    if (i >= 0 && /[矩阵|A-Z]/.test(v.slice(Math.max(0, i - 8), i))) {
      console.log(' ', p.code, f, '|', v.slice(Math.max(0, i - 45), i + 55).replace(/\n/g, ' '));
      n++;
      break;
    }
  }
  if (n >= 10) break;
}

if (WRITE) {
  fs.copyFileSync(DB_FILE, DB_FILE + '.before-notation-' + Date.now() + '.json');
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2) + '\n', 'utf8');
  console.log('\n已写回 data/db.json');
} else {
  console.log('\n只报告，未写盘。确认后加 --write。');
}
