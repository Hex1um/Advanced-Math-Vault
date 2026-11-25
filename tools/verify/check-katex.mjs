#!/usr/bin/env node
/**
 * 用真 KaTeX 校验题库里的每个数学片段能不能渲染。
 * 只报告，不改数据。
 *
 *   node tools/verify/check-katex.mjs            # 校验 data/db.json
 *   node tools/verify/check-katex.mjs --detail   # 打印失败样例
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const DETAIL = process.argv.includes('--detail');

// 用仓库自带的本地 KaTeX（docs/vendor/katex/katex.min.js），不再依赖某台机器的 node_modules 绝对路径。
const katexDir = process.env.KATEX_DIR || path.join(ROOT, 'docs', 'vendor', 'katex');
const katexFile = path.join(katexDir, 'katex.min.js');
if (!fs.existsSync(katexFile)) {
  console.error('找不到本地 KaTeX: ' + katexFile);
  process.exit(2);
}
const require = createRequire(import.meta.url);
const katex = require(katexFile);

function segments(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === '$') {
      const end = s.indexOf('$$', i + 2);
      if (end > 0) { out.push({ display: true, tex: s.slice(i + 2, end) }); i = end + 2; continue; }
    }
    if (s[i] === '$') {
      let j = i + 1, closed = -1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '$') { closed = j; break; }
        j++;
      }
      if (closed > 0) { out.push({ display: false, tex: s.slice(i + 1, closed) }); i = closed + 1; continue; }
    }
    i++;
  }
  return out;
}

let problems = [];
if (fs.existsSync(DB_FILE)) {
  problems = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).problems || [];
} else {
  // 新克隆没有运行时 db.json：退回仓库内的 batch 题库，保证脚本开箱可跑
  const dir = path.join(ROOT, 'data');
  for (const f of fs.readdirSync(dir).filter((x) => /^batch.*\.json$/.test(x)).sort()) {
    const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (Array.isArray(arr)) problems = problems.concat(arr);
  }
  console.log('未找到 data/db.json，改用 batch 题库：' + problems.length + ' 题');
}
let badProblems = 0, badSegs = 0, totalSegs = 0;
const samples = [];
const byReason = {};

for (const p of problems) {
  let bad = 0;
  for (const seg of segments(p.statement || '')) {
    totalSegs++;
    if (!seg.tex.trim()) continue;
    try {
      katex.renderToString(seg.tex, { displayMode: seg.display, throwOnError: true, strict: false });
    } catch (e) {
      bad++; badSegs++;
      const msg = String(e.message).split('\n')[0].slice(0, 90);
      byReason[msg] = (byReason[msg] || 0) + 1;
      if (samples.length < (DETAIL ? 25 : 5)) samples.push({ code: p.code, tex: seg.tex.slice(0, 60), msg });
    }
  }
  if (bad) badProblems++;
}

console.log('题数', problems.length, '| 数学片段', totalSegs, '| 渲染失败片段', badSegs, '| 受影响题目', badProblems);
console.log('失败原因 TOP:');
Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k, v]) => console.log('  ', v, k));
for (const s of samples) console.log('  -', s.code, '|', s.tex, '|', s.msg);

/* CI 用：--max-fail=0 时，只要有一个片段渲染不了就非零退出 */
const maxFlag = (process.argv.find((a) => a.startsWith('--max-fail=')) || '').split('=')[1];
if (maxFlag !== undefined) {
  const max = Number(maxFlag);
  if (Number.isFinite(max) && badSegs > max) {
    console.error('✗ 渲染失败片段 ' + badSegs + ' 个，超过允许上限 ' + max);
    process.exit(1);
  }
  console.log('✓ 渲染失败片段在允许上限内（' + badSegs + ' ≤ ' + max + '）');
}
