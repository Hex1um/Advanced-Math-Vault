/**
 * 三维评分重算：只用可解释的客观特征，不做玄学打分。
 *
 * 设计原则（写进 explanation 便于以后复核）：
 *  - thinking（思维量，1-10）：想「用什么方法」的难度。有证明/构造/反例 +2；
 *    需要换元或变形 +1；纯代入计算不加分。选择题天然比大题低。
 *  - difficulty（难度，1-15）：上手难度，含易错程度。在 thinking 基础上，
 *    题干越长、条件越多、要讨论的情形越多越高。
 *  - calc（计算量，1-10）：纯工作量。按公式密度、积分/求和重数、矩阵阶数估。
 *
 * 用法：
 *   node tools/rescore.mjs                 # 只统计，不写库
 *   node tools/rescore.mjs --apply         # 写库
 *   node tools/rescore.mjs --apply --all   # 连手工题一起重算（危险，默认只算机器估的）
 */
import fs from 'node:fs';

const DB = 'data/db.json';
const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');

const db = JSON.parse(fs.readFileSync(DB, 'utf8'));

const count = (t, re) => (t.match(re) || []).length;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

function score(p) {
  const stem = String(p.statement || '');
  const kind = /选择题/.test(p.title || '') ? 'choice'
    : /填空题/.test(p.title || '') ? 'fill' : 'solution';
  const L = stem.length;

  // ---------- thinking ----------
  let th = kind === 'choice' ? 3.5 : kind === 'fill' ? 4.5 : 5.5;

  if (/证明|求证|试证|证明题/.test(stem)) th += 2.2;              // 证明题要构造思路
  if (/是否存在|举反例|反例|至少存在|存在性/.test(stem)) th += 1.8;
  if (/讨论|分类讨论|试讨论|参数.*取值范围|求.*的范围/.test(stem)) th += 1.2;
  if (/\\lim/.test(stem)) th += 0.6;                              // 极限题常要选等价/泰勒
  if (/抽象|一般地|对任意|任意.*成立/.test(stem)) th += 0.8;      // 抽象题更难想
  if (count(stem, /\\iint|\\iiint|\\oint/g)) th += 0.8;           // 重积分/曲线曲面要先选坐标系
  if (/方法二|一题多解/.test(stem)) th += 0.5;
  if (/则必有|下列.*正确的是|下列.*错误的是/.test(stem)) th -= 0.4;  // 纯辨析题略降
  if (kind === 'choice' && L < 90) th -= 0.5;                     // 短选择往往套路化
  // 题干很短又只有一个运算：多半是套公式题，不该因为出现 \lim / \frac 就加分
  if (L < 80 && count(stem, /\\lim|\\int|\\frac|\\sqrt/g) <= 2) th -= 0.8;
  th = clamp(th, 1, 10);

  // ---------- difficulty ----------
  let df = kind === 'choice' ? 4 : kind === 'fill' ? 5 : 6.5;
  df += (th - 5) * 0.75;                                          // 思维量和难度正相关
  if (L > 260) df += 1;
  if (L > 500) df += 1;
  if (count(stem, /\\begin\{(cases|array|matrix|vmatrix|pmatrix)\}/g) >= 2) df += 1;  // 多条件
  if (/讨论|分类/.test(stem)) df += 1;
  if (/\\sum_\{n=\d+\}\^\{\\infty\}/.test(stem)) df += 0.5;
  df = Math.max(1, Math.min(15, Math.round(df)));

  // ---------- calc ----------
  let ca = kind === 'choice' ? 3 : kind === 'fill' ? 4.5 : 6;
  const ops = count(stem, /\\int|\\iint|\\iiint|\\sum|\\prod|\\lim|\\frac|\\sqrt/g);
  ca += Math.min(3, ops * 0.32);                                  // 公式越密越要算
  if (count(stem, /\\iint|\\iiint/g)) ca += 1;
  if (/\\sum_\{n=\d+\}\^\{\\infty\}/.test(stem)) ca += 0.8;
  if (L > 350) ca += 0.8;
  if (/证明/.test(stem)) ca -= 1.2;                               // 证明题算得少想得多
  if (L < 100 && ops <= 2) ca -= 1.5;                             // 短式子基本一两步算完
  ca = clamp(ca, 1, 10);

  return { thinking: th, difficulty: df, calc: ca, kind };
}

const targets = db.problems.filter((p) => {
  if (p.status !== 'approved') return false;
  if (ALL) return true;
  // 默认只重算「机器估分」的：考研真题批次，以及三维完全相同的
  return /硕士研究生招生考试/.test(p.source || '')
    || (p.thinking === p.difficulty && p.difficulty === p.calc);
});

const before = {};
let changed = 0;
const samples = [];
for (const p of targets) {
  const s = score(p);
  const key = `${p.thinking}/${p.difficulty}/${p.calc}`;
  before[key] = (before[key] || 0) + 1;
  if (p.thinking !== s.thinking || p.difficulty !== s.difficulty || p.calc !== s.calc) {
    changed++;
    if (samples.length < 8) {
      samples.push({
        code: p.code, kind: s.kind,
        from: `${p.thinking}/${p.difficulty}/${p.calc}`,
        to: `${s.thinking}/${s.difficulty}/${s.calc}`,
        stem: String(p.statement).slice(0, 70).replace(/\s+/g, ' ')
      });
    }
    p.thinking = s.thinking;
    p.difficulty = s.difficulty;
    p.calc = s.calc;
  }
}

console.log('待重算', targets.length, '题｜实际变动', changed, '题');
console.log('\n变动样本：');
for (const s of samples) console.log(`  ${s.code} [${s.kind}] ${s.from} -> ${s.to}  ${s.stem}`);

// 分布对比
const dist = (probs) => {
  const d = { thinking: {}, difficulty: {}, calc: {} };
  for (const p of probs) for (const k of ['thinking', 'difficulty', 'calc']) d[k][p[k]] = (d[k][p[k]] || 0) + 1;
  return d;
};
const after = dist(db.problems.filter((p) => p.status === 'approved'));
console.log('\n重算后全库分布（approved）：');
for (const k of ['thinking', 'difficulty', 'calc']) {
  const keys = Object.keys(after[k]).map(Number).sort((a, b) => a - b);
  console.log('  ' + k.padEnd(11) + keys.map((x) => x + ':' + after[k][x]).join(' '));
}

if (APPLY) {
  fs.writeFileSync(DB, JSON.stringify(db, null, 2), 'utf8');
  console.log('\n已写库');
} else {
  console.log('\n（预演，未写库。加 --apply 生效）');
}
