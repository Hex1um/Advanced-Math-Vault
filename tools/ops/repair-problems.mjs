#!/usr/bin/env node
/**
 * 题库清理：重复题下线 + 缺答案补录（默认只报告，--write 才写盘）
 *
 *   node tools/ops/repair-problems.mjs               # 报告
 *   node tools/ops/repair-problems.mjs --write       # 应用
 *   node tools/ops/repair-problems.mjs --json out.json
 *
 * 两类问题都来自历史批量导入：
 *   1. 同一道题从「数学笔记截图」和「柳贯一题型专项」各导了一次，题干归一化后逐字相同
 *      （去空白、去 $ 与反斜杠后比较）。保留下限编号（链接、引用都指向它），
 *      其余标记 rejected 并把 reason 写清楚，同时把用户做题记录迁到保留编号上。
 *   2. 早年真题的 answer 字段为空，但 solution 里其实给了结论。只做高置信度回填：
 *      · 选择题：解析里显式写「故选（C）」「应选 B」「答案选 D」
 *      · 填空题：解析最后一段就是答案（形如 $$...$$ 且题目本身带空）
 *      拿不准的一律不动，只在报告里列出来，避免把中间步骤当答案写进去。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const WRITE = process.argv.includes('--write');
const JSON_OUT = (() => {
  const i = process.argv.indexOf('--json');
  return i > 0 ? process.argv[i + 1] : '';
})();

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const problems = db.problems || [];

/* ------------------------------------------------------------ 重复题 */

/** 题干归一化：只比「到底是不是同一道题」，不关心排版差异 */
function normStatement(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[\\$]/g, '')
    .replace(/[，,。；;：:]/g, '')
    .toLowerCase();
}

const approved = problems.filter((p) => p.status === 'approved');
const groups = new Map();
for (const p of approved) {
  const k = normStatement(p.statement);
  if (!k) continue;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(p);
}
const dupGroups = [...groups.values()].filter((g) => g.length > 1);

const dupPlan = dupGroups.map((g) => {
  // 保留编号最小的（老链接、外部引用都指向它），其余下线
  const sorted = g.slice().sort((a, b) => String(a.code).localeCompare(String(b.code)));
  return { keep: sorted[0], drop: sorted.slice(1) };
});

/* ------------------------------------------------------------ 缺答案 */

const CHOICE_PATTERNS = [
  /(?:故|所以|因而不难|从而)?\s*应?\s*选\s*[（(]?\s*([A-D])\s*[）)]?/,
  /答案\s*(?:是|为|:|：)\s*[（(]?\s*([A-D])\s*[）)]?/,
  /正确选项\s*(?:是|为|:|：)?\s*[（(]?\s*([A-D])\s*[）)]?/
];

function isChoice(p) {
  return /选择题/.test(p.kind || '') || /选择题/.test(p.title || '');
}

function isFill(p) {
  return /填空题/.test(p.kind || '') || /填空题/.test(p.title || '');
}

function pickChoiceAnswer(solution) {
  for (const re of CHOICE_PATTERNS) {
    const m = String(solution || '').match(re);
    if (m) return m[1];
  }
  return '';
}

/** 填空题：解析尾部最后一个独立公式块，且其后不再有正文 */
function pickFillAnswer(statement, solution) {
  const s = String(solution || '').trim();
  if (!s) return '';
  const tail = s.match(/\$\$([\s\S]{1,200}?)\$\$\s*$/);
  if (!tail) return '';
  const body = tail[1].trim();
  if (!body || body.length > 160) return '';
  // 题干必须真的带空（下划线、括号空位、中文「为 ，」这类），否则不是填空
  const blank = /_{2,}|＿{2,}|（\s*）|\(\s*\)|为\s*[，,。]|等于$/.test(String(statement || ''));
  if (!blank) return '';
  return '$$' + body + '$$';
}

const fillPlan = [];
const ambiguous = [];
const objectiveNoAnswer = [];
for (const p of approved) {
  if (p.answer && String(p.answer).trim()) continue;
  const kind = p.kind || '';
  const objective = isChoice(p) || isFill(p);
  /* 证明题 / 解答题的答案就是解析本身，空 answer 不是缺陷。
     早期报告的「378 条缺答案」里 352 条属于这一类，只有客观题才是真缺口。 */
  if (!objective) continue;
  objectiveNoAnswer.push(p.code);
  if (isChoice(p)) {
    const ans = pickChoiceAnswer(p.solution);
    if (ans) fillPlan.push({ code: p.code, answer: ans, from: '选择题解析"故选"' });
    else ambiguous.push({ code: p.code, why: '选择题解析里没有明确的「故选」表述' });
    continue;
  }
  const ans = pickFillAnswer(p.statement, p.solution);
  if (ans) fillPlan.push({ code: p.code, answer: ans, from: '填空题解析末段公式' });
  else ambiguous.push({ code: p.code, why: '填空题解析末尾没有独立公式块' });
  void kind;
}

/* ------------------------------------------------------------ 应用 */

function applyDup() {
  let dropped = 0, moved = 0;
  const byCode = new Map(problems.map((p) => [p.code, p]));
  for (const { keep, drop } of dupPlan) {
    for (const d of drop) {
      d.status = 'rejected';
      d.rejectReason = '重复题：题干与 ' + keep.code + ' 完全相同，保留编号较小的一条';
      d.dupOf = keep.code;
      d.reviewedAt = new Date().toISOString();
      dropped++;
      // 用户做题记录迁到保留编号，避免「做过但题库里找不到」
      for (const u of db.users || []) {
        const rec = u.solved && u.solved[d.code];
        if (!rec) continue;
        u.solved[keep.code] = Object.assign({}, rec, { migratedFrom: d.code });
        delete u.solved[d.code];
        moved++;
      }
      for (const post of db.posts || []) {
        if (post.problemCode === d.code) post.problemCode = keep.code;
      }
      for (const k of Object.keys(db.daily || {})) {
        const rec = db.daily[k];
        if (rec && rec.code === d.code) rec.code = keep.code;
      }
      void byCode;
    }
  }
  return { dropped, moved };
}

function applyAnswers() {
  let filled = 0;
  for (const f of fillPlan) {
    const p = problems.find((x) => x.code === f.code);
    if (!p || (p.answer && String(p.answer).trim())) continue;
    p.answer = f.answer;
    p.answerFilledBy = 'repair-problems:' + f.from;
    filled++;
  }
  return filled;
}

console.log('题库 ' + problems.length + ' 题（approved ' + approved.length + '）');
console.log('\n[1] 重复题');
console.log('  重复组 ' + dupPlan.length + ' 组，涉及 ' + dupPlan.reduce((s, g) => s + 1 + g.drop.length, 0) + ' 题');
for (const g of dupPlan.slice(0, 8)) {
  console.log('    保留 ' + g.keep.code + ' 下线 ' + g.drop.map((d) => d.code).join(', '));
}
if (dupPlan.length > 8) console.log('    …其余 ' + (dupPlan.length - 8) + ' 组见 --json 报告');

console.log('\n[2] 缺答案（仅客观题）');
console.log('  客观题缺答案 ' + objectiveNoAnswer.length + ' 条：可回填 ' + fillPlan.length + '，需人工判断 ' + ambiguous.length);
const byFrom = {};
for (const f of fillPlan) byFrom[f.from] = (byFrom[f.from] || 0) + 1;
for (const k of Object.keys(byFrom)) console.log('    ' + k + '：' + byFrom[k]);
if (ambiguous.length) {
  console.log('    需人工：' + ambiguous.map((a) => a.code).join(', '));
}

if (!WRITE) {
  console.log('\n未写盘（加 --write 应用）。');
} else {
  const bak = DB_FILE + '.before-repair-' + Date.now() + '.json';
  fs.copyFileSync(DB_FILE, bak);
  const dup = applyDup();
  const filled = applyAnswers();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  console.log('\n已写盘：' + DB_FILE);
  console.log('  下线重复题 ' + dup.dropped + ' 条，迁移做题记录 ' + dup.moved + ' 条，回填答案 ' + filled + ' 条');
  console.log('  备份：' + path.basename(bak));
}

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({
    dupGroups: dupPlan.map((g) => ({ keep: g.keep.code, drop: g.drop.map((d) => d.code) })),
    fillPlan, ambiguous
  }, null, 2), 'utf8');
  console.log('报告：' + JSON_OUT);
}

/* 客观题缺答案的人工清单：交给审核后台/管理员逐条补 */
if (ambiguous.length) {
  const listFile = path.join(ROOT, 'data', 'answer-missing.json');
  fs.writeFileSync(listFile, JSON.stringify(ambiguous.map((a) => {
    const p = problems.find((x) => x.code === a.code) || {};
    return { code: a.code, title: p.title || '', why: a.why, statement: (p.statement || '').slice(0, 300) };
  }), null, 2), 'utf8');
  console.log('人工清单：' + path.relative(ROOT, listFile));
}
