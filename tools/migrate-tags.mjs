#!/usr/bin/env node
/**
 * 把历史题库迁移到「主标签 + 子标签」体系。
 *
 *   node tools/migrate-tags.mjs            # 只报告，不写盘
 *   node tools/migrate-tags.mjs --write    # 写入 data/batch*.json 和 data/db.json
 *
 * 规则见根目录 tag-taxonomy.js。原始标签不会丢：无法归类的会打印出来；
 * 「选择题 / 填空题 / 证明 / 应用题」会转存到 problem.kind。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const tax = require(path.join(ROOT, 'tag-taxonomy.js'));
const WRITE = process.argv.includes('--write');

const files = [
  ...fs.readdirSync(path.join(ROOT, 'data'))
    .filter((f) => /^batch.*\.json$/.test(f))
    .map((f) => path.join(ROOT, 'data', f)),
  path.join(ROOT, 'data', 'problems.seed.sample.json'),
  path.join(ROOT, 'data', 'db.json')
].filter((f) => fs.existsSync(f));

const stats = {
  problems: 0, changed: 0, removed: 0, unknown: 0, kind: 0,
  mains: new Map(), subs: new Map(), unknownTags: new Map(), droppedTags: new Map()
};

function bump(map, key) { map.set(key, (map.get(key) || 0) + 1); }

function migrateProblem(p) {
  const before = JSON.stringify({ tags: p.tags || [], mainTag: p.mainTag || '', kind: p.kind || '' });
  const r = tax.normalize(p.tags, p.mainTag);
  p.mainTag = r.mainTag;
  p.tags = r.tags;
  if (r.kind) { p.kind = r.kind; stats.kind++; } else if (!p.kind) delete p.kind;
  for (const t of r.dropped) { bump(stats.droppedTags, t); stats.removed++; }
  for (const t of r.unknown) { bump(stats.unknownTags, t); stats.unknown++; }
  bump(stats.mains, p.mainTag);
  for (const s of p.tags) bump(stats.subs, s);
  const after = JSON.stringify({ tags: p.tags, mainTag: p.mainTag, kind: p.kind || '' });
  if (before !== after) stats.changed++;
}

for (const file of files) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error('跳过无法解析的文件:', file, e.message); continue; }
  const list = Array.isArray(data) ? data : (Array.isArray(data.problems) ? data.problems : null);
  if (!list) continue;
  for (const p of list) {
    if (!p || typeof p !== 'object' || !p.title) continue;
    stats.problems++;
    migrateProblem(p);
  }
  if (WRITE && path.basename(file) === 'db.json') {
    const bak = file + '.before-tags-' + Date.now() + '.json';
    fs.copyFileSync(file, bak);
    console.log('已备份 ' + path.basename(bak));
  }
  if (WRITE && Array.isArray(data)) {
    const out = Array.isArray(data) ? data : data;
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
  } else if (WRITE && data.problems) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
  console.log((WRITE ? '已写入 ' : '检查 ') + path.relative(ROOT, file));
}

const printMap = (title, map, limit) => {
  console.log('\n' + title);
  [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit || 100)
    .forEach(([k, v]) => console.log(String(v).padStart(6) + '  ' + k));
};

console.log('\n题数 ' + stats.problems + ' | 变更 ' + stats.changed + ' | 删除旧标签 ' + stats.removed + ' | 未识别 ' + stats.unknown + ' | 题型 ' + stats.kind);
printMap('主标签分布', stats.mains);
printMap('子标签分布（前 60）', stats.subs, 60);
if (stats.unknownTags.size) printMap('未识别标签', stats.unknownTags, 50);
if (stats.droppedTags.size) printMap('被删除的标签（前 50）', stats.droppedTags, 50);
if (!WRITE) console.log('\n只报告，未写盘。确认后加 --write。');
