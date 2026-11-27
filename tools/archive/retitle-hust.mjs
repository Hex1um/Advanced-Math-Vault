#!/usr/bin/env node
/**
 * 华科那批题的标题原来只有「微积分（一）（上）期中考试」十种，754 道题重名，
 * 列表里根本分不出是哪份卷子、第几题。这里按「学年 + 科目 + 场次 + 题号」重生成。
 *   node tools/archive/retitle-hust.mjs [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const APPLY = process.argv.includes('--apply');
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

const hust = db.problems.filter((p) => (p.source || '').includes('华中科技'));
const groups = new Map();
for (const p of hust) {
  const k = p.source;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(p);
}

function shortSource(src) {
  // 华中科技大学 2011-2012学年微积分（一）（上）期中考试
  const m = src.match(/华中科技大学\s*(\d{4})(?:-(\d{4}))?\s*学年?\s*(.*)$/);
  if (!m) return { year: '', exam: src.replace('华中科技大学', '').trim() };
  const y1 = m[1], y2 = m[2];
  const year = y2 ? y1.slice(2) + '-' + y2.slice(2) : y1;
  let exam = (m[3] || '').replace(/考试$/, '').trim();
  // 微积分（一）（上）期中 -> 微积分(一)上·期中
  exam = exam.replace(/（/g, '(').replace(/）/g, ')')
    .replace(/\((一|二)\)\s*\((上|下)\)/, '($1)$2')
    .replace(/\((上|下)\)/, '$1')
    .replace(/期中$/, '·期中').replace(/期末$/, '·期末');
  return { year, exam };
}

let changed = 0;
const samples = [];
for (const [src, list] of groups) {
  const { year, exam } = shortSource(src);
  list.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  list.forEach((p, i) => {
    const title = (year ? year + ' ' : '') + exam + ' · 第' + (i + 1) + '题';
    if (p.title !== title) { p.title = title; changed++; }
    if (samples.length < 5) samples.push(p.code + ' -> ' + title);
  });
}

const after = new Set(hust.map((p) => p.title));
console.log('华科题', hust.length, '| 改动', changed, '| 改后不同标题数', after.size);
samples.forEach((s) => console.log('  ', s));

if (APPLY) {
  const bak = DB_FILE + '.before-retitle-' + Date.now() + '.json';
  fs.copyFileSync(DB_FILE, bak);
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  console.log('已写盘 | 备份', path.basename(bak));
}
