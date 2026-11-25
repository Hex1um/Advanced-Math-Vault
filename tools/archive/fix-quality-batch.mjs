#!/usr/bin/env node
/**
 * 一次性质量修批：
 *   1) 把题干里混进去的「（答案：…）」抽到 answer 字段，并从题干删掉
 *   2) 修 `$$` 错位导致的 $ 不配对（KaTeX 会整段不渲染）
 *   3) 难度整体重标：★★★ 一律给 10 分太粗暴，按曲线压到 3–9
 *
 *   node tools/archive/fix-quality-batch.mjs            # 只报告
 *   node tools/archive/fix-quality-batch.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const APPLY = process.argv.includes('--apply');
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v))));

/* ---------- 1. 题干里的答案 ---------- */
/* 答案里经常套括号和 $...$（如 （答案：$x^2(1+y^2)=C$）），
   所以按括号配平扫描，而不是用正则截断。 */
function extractAnswer(s) {
  const m = /[（(]\s*答\s*案\s*[：:]/.exec(s);
  if (!m) return null;
  const open = m.index;
  let depth = 0, inMath = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '$') inMath = !inMath;
    if (inMath) continue;
    if (ch === '（' || ch === '(') depth++;
    else if (ch === '）' || ch === ')') {
      depth--;
      if (depth === 0) {
        const inner = s.slice(open + 1, i);
        const val = inner.replace(/^\s*答\s*案\s*[：:]\s*/, '').trim();
        return { start: open, end: i + 1, value: val };
      }
    }
  }
  return null;
}
/* 另一种脏数据：题干被答案碎片截断，形如「…和函数。$，$s(x)=-\ln(1-x)$）」
   只在明确出现「。$，$」这种畸形片段时才截断，避免误伤正常公式后的中文逗号。 */
function splitDollarComma(s) {
  const m = /。\s*\$\s*，\s*\$\s*([^$]{0,120})\$?\s*[）)]?\s*$/.exec(s);
  if (!m) return null;
  return { head: s.slice(0, m.index + 1).trim(), value: m[1].trim() };
}

let ansMoved = 0;
const ansSamples = [];
for (const p of db.problems) {
  const s = String(p.statement || '');
  if (!/答\s*案\s*[：:]|\$，/.test(s)) continue;
  let cleaned = s;
  let found = '';
  const hit = extractAnswer(s);
  if (hit) {
    found = hit.value;
    cleaned = (s.slice(0, hit.start) + s.slice(hit.end)).replace(/[ \t]{2,}/g, ' ').trim();
  } else {
    const dc = splitDollarComma(s);
    if (dc) { cleaned = dc.head; found = dc.value; }
  }
  if (!found) continue;
  if (ansSamples.length < 5) ansSamples.push([p.code, found.slice(0, 40)]);
  if (APPLY) {
    p.statement = cleaned;
    if (!String(p.answer || '').trim()) p.answer = found;
  }
  ansMoved++;
}

/* ---------- 2. $ 配对修复 ---------- */
const countD = (s) => (s.match(/\$/g) || []).length;
let fixedDollar = 0;
const dollarSamples = [];
for (const p of db.problems) {
  const s = String(p.statement || '');
  if (countD(s) % 2 === 0) continue;
  // 把中文字符/标点后紧跟的 "$$" 收成 "$"（最典型的误写：$...=0$$，）
  let t = s.replace(/\$\$(?=[，。；、,.;）)])/g, '$');
  // 仍未配平：把最后一个孤立的 "$$" 收成 "$"
  if (countD(t) % 2 === 1) {
    const last = t.lastIndexOf('$$');
    if (last >= 0) t = t.slice(0, last) + '$' + t.slice(last + 2);
  }
  if (countD(t) % 2 === 0 && t !== s) {
    if (dollarSamples.length < 5) dollarSamples.push([p.code, s.slice(0, 50)]);
    if (APPLY) p.statement = t;
    fixedDollar++;
  }
}

/* ---------- 3. 难度重标 ---------- */
// 原来的 ★★★ → 10 是机械映射，导致 1142 道题挤在 9–10。
// 曲线：3 + 0.55*(v-1)，再夹到 3–9；计算量单独用 2 + 0.62*(v-1)。
const curveDiff = (v) => clamp(2.5 + 0.55 * ((Number(v) || 6) - 1), 3, 9);
const curveThink = (v) => clamp(2.5 + 0.55 * ((Number(v) || 6) - 1), 3, 9);
const curveCalc = (v) => clamp(2 + 0.62 * ((Number(v) || 5) - 1), 2, 9);
let rescaled = 0;
const before = { 9: 0, 10: 0 };
for (const p of db.problems) {
  if (p.status !== 'approved') continue;
  if (p.diffRescaled) continue;
  if (p.difficulty >= 9) before[p.difficulty]++;
  const nd = curveDiff(p.difficulty), nt = curveThink(p.thinking), nc = curveCalc(p.calc);
  if (nd !== p.difficulty || nt !== p.thinking || nc !== p.calc) {
    if (APPLY) { p.thinking = nt; p.difficulty = nd; p.calc = nc; p.diffRescaled = 2; }
    rescaled++;
  } else if (APPLY) p.diffRescaled = 2;
}

console.log(`题干含答案：${ansMoved} 道（样例 ${ansSamples.slice(0, 3).map((s) => s[0]).join(',')}）`);
console.log(`$ 配对修复：${fixedDollar} 道（样例 ${dollarSamples.slice(0, 3).map((s) => s[0]).join(',')}）`);
console.log(`难度重标：${rescaled} 道（原 9 分 ${before[9]} 道、10 分 ${before[10]} 道）`);

if (APPLY) {
  const bak = DB_FILE + '.before-quality-' + Date.now() + '.json';
  fs.copyFileSync(DB_FILE, bak);
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  const app = db.problems.filter((p) => p.status === 'approved');
  const dist = {};
  for (const p of app) dist[p.difficulty] = (dist[p.difficulty] || 0) + 1;
  console.log('难度分布:', JSON.stringify(dist));
  console.log('已写盘 | 备份', path.basename(bak));
}
