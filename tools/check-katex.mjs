#!/usr/bin/env node
/**
 * 用真 KaTeX 校验题库里的每个数学片段能不能渲染。
 * 只报告，不改数据。
 *
 *   node tools/check-katex.mjs            # 校验 data/db.json
 *   node tools/check-katex.mjs --detail   # 打印失败样例
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
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

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
let badProblems = 0, badSegs = 0, totalSegs = 0;
const samples = [];
const byReason = {};

for (const p of db.problems) {
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

console.log('题数', db.problems.length, '| 数学片段', totalSegs, '| 渲染失败片段', badSegs, '| 受影响题目', badProblems);
console.log('失败原因 TOP:');
Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k, v]) => console.log('  ', v, k));
for (const s of samples) console.log('  -', s.code, '|', s.tex, '|', s.msg);
