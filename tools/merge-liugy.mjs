#!/usr/bin/env node
/**
 * 合并 liugy-out/out_*.json → 校验 → 去重（批内 + 与现有题库）→ 输出可导入批次
 *
 *   node tools/merge-liugy.mjs            # 只统计
 *   node tools/merge-liugy.mjs --write    # 写 data/batch-liu-XX.json
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const SRC_DIR = process.env.SRC_DIR || path.join(ROOT, 'liugy-out');
const WRITE = process.argv.includes('--write');

/* 题干指纹：去掉格式包装、保留函数名与符号，中文与数字都留 */
function norm(s) {
  let t = String(s || '').toLowerCase();
  t = t.replace(/\\(?:mathrm|operatorname|text|displaystyle|dfrac|tfrac|left|right|big|bigg|quad|qquad)\b\s*/g, '');
  t = t.replace(/\\([a-zA-Z]+)/g, '$1');
  t = t.replace(/[{}\[\]$^_~\\\s，。；、,.;:：！!？?（）()「」"'\u2018\u2019\u201c\u201d\-—·]/g, '');
  return t;
}

const clamp = (v, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : d;
};

const files = fs.existsSync(SRC_DIR)
  ? fs.readdirSync(SRC_DIR).filter((f) => /^(?:out|_part)[\w\-]*\.json$/i.test(f)).sort()
  : [];
if (!files.length) { console.log('没有找到 out_*.json'); process.exit(0); }

const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : { problems: [] };
const existing = new Set(db.problems.map((p) => norm(p.statement)));

let raw = [];
const perFile = [];
for (const f of files) {
  const full = path.join(SRC_DIR, f);
  let list = [];
  try { list = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { console.log('✗ JSON 解析失败', f, e.message); continue; }
  if (!Array.isArray(list)) { console.log('✗ 不是数组', f); continue; }
  perFile.push([f, list.length]);
  list.forEach((p) => raw.push(Object.assign({ _f: f }, p)));
}

const bad = { noTitle: 0, noStatement: 0, shortStatement: 0, noAnswer: 0 };
const seen = new Set();
const dupIn = [];
const dupDb = [];
const keep = [];

for (const p of raw) {
  const title = String(p.title || '').trim();
  const statement = String(p.statement || '').trim();
  if (!title) { bad.noTitle++; continue; }
  if (!statement) { bad.noStatement++; continue; }
  if (statement.length < 12) { bad.shortStatement++; continue; }

  const key = norm(statement);
  if (existing.has(key)) { dupDb.push(p); continue; }
  if (seen.has(key)) { dupIn.push(p); continue; }
  seen.add(key);

  let tags = p.tags;
  if (typeof tags === 'string') tags = tags.split(/[,，、\s]+/);
  tags = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : [];
  tags = tags.slice(0, 3);
  if (!tags.length) tags = ['未分类'];

  keep.push({
    title: title.slice(0, 120),
    statement,
    tags,
    thinking: clamp(p.thinking, 6),
    difficulty: clamp(p.difficulty, 7),
    calc: clamp(p.calc !== undefined ? p.calc : 6, 6),
    source: String(p.source || '柳贯一题型专项').slice(0, 80),
    hints: (Array.isArray(p.hints) ? p.hints : (p.hints ? [p.hints] : [])).map(String).filter(Boolean).slice(0, 3),
    answer: String(p.answer || '').trim(),
    solution: String(p.solution || '').trim(),
    authorName: '柳贯一题型专项'
  });
  if (!keep[keep.length - 1].answer) bad.noAnswer++;
}

console.log('输入文件:', files.length, perFile.map(([f, n]) => f + ':' + n).join(' '));
console.log('原始', raw.length, '| 保留', keep.length, '| 与题库重复', dupDb.length, '| 批内重复', dupIn.length);
console.log('丢弃:', JSON.stringify(bad));

const bySource = {};
for (const p of keep) {
  const k = p.source.replace(/^柳贯一题型专项\s*·?\s*/, '');
  bySource[k] = (bySource[k] || 0) + 1;
}
const top = Object.entries(bySource).sort((a, b) => b[1] - a[1]);
console.log('覆盖题型节数', top.length);
console.log('题量 TOP10:', top.slice(0, 10).map(([k, v]) => k + ':' + v).join(' | '));
const noAns = keep.filter((p) => !p.answer).length;
console.log('缺答案', noAns, '(' + Math.round(100 * noAns / keep.length) + '%)');

if (WRITE) {
  const outDir = path.join(ROOT, 'data');
  const size = 200;
  let seq = 0;
  for (let i = 0; i < keep.length; i += size) {
    seq++;
    const chunk = keep.slice(i, i + size);
    const f = path.join(outDir, 'batch-liu-' + String(seq).padStart(2, '0') + '.json');
    fs.writeFileSync(f, JSON.stringify(chunk, null, 1), 'utf8');
    console.log('写入', path.basename(f), chunk.length);
  }
}
