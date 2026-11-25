#!/usr/bin/env node
/**
 * 一次性迁移：data/db.json → data/db.sqlite
 *
 *   node tools/ops/migrate-json-to-sqlite.mjs                 # 迁移 + 校验
 *   node tools/ops/migrate-json-to-sqlite.mjs --dry           # 只报告，不写库
 *   node tools/ops/migrate-json-to-sqlite.mjs --force         # 目标库已有数据也覆盖
 *   node tools/ops/migrate-json-to-sqlite.mjs --export-back /tmp/back.json   # 从 SQLite 反向导出，做回环比对
 *
 * 迁移完把服务启动命令加上 DB_ENGINE=sqlite 即可（server.js 启动时若发现
 * 目标 sqlite 为空，也会自动从 db.json 导入一次，两条路径等价）。
 *
 * 校验口径：逐行比 JSON 字符串，不是只比行数——行数对但内容错位是最容易漏的坑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const { createStore } = require(path.join(ROOT, 'lib', 'store.js'));

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
};

const DB_FILE = path.resolve(flag('db', process.env.DB_FILE || path.join(ROOT, 'data', 'db.json')));
const SQLITE_FILE = path.resolve(flag('sqlite', DB_FILE.replace(/\.json$/i, '') + '.sqlite'));
const DRY = argv.includes('--dry');
const FORCE = argv.includes('--force');
const EXPORT_BACK = flag('export-back', '');

if (!fs.existsSync(DB_FILE) && !EXPORT_BACK) {
  console.error('✗ 找不到 ' + DB_FILE + '（线上库请先用 tools/ops/sync-live.mjs 导出到本地）');
  process.exit(2);
}

const store = createStore({ engine: 'sqlite', dbFile: DB_FILE, sqliteFile: SQLITE_FILE, mirrorJson: false });

function counts(db) {
  return {
    problems: (db.problems || []).length,
    users: (db.users || []).length,
    posts: (db.posts || []).length,
    submissions: (db.submissions || []).length,
    feedbacks: (db.feedbacks || []).length,
    sessions: Object.keys(db.sessions || {}).length,
    daily: Object.keys(db.daily || {}).length,
    emailCodes: Object.keys(db.emailCodes || {}).length
  };
}

function fmt(o) {
  return Object.entries(o).map(([k, v]) => k + '=' + v).join(' · ');
}

console.log('源库  ' + DB_FILE);
console.log('目标  ' + SQLITE_FILE);

if (EXPORT_BACK) {
  // 从 SQLite 反向导出：用来验证「迁回去还能拿回同一份数据」
  store.open();
  const back = store.load();
  if (!back) { console.error('✗ SQLite 里没有数据'); process.exit(1); }
  fs.writeFileSync(EXPORT_BACK, JSON.stringify(back, null, 2), 'utf8');
  console.log('已导出 ' + EXPORT_BACK + '：' + fmt(counts(back)));
  process.exit(0);
}

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const src = counts(db);
console.log('源库内容 ' + fmt(src));

const exists = fs.existsSync(SQLITE_FILE);
store.open();
const hasData = store.hasData();
if (hasData && !FORCE && !DRY) {
  console.error('✗ 目标库已有数据。确认要覆盖请加 --force（原文件不会被自动删除，建议先备份）');
  process.exit(2);
}
if (DRY) {
  console.log('--dry：未写库。' + (exists ? '目标文件已存在，' : '目标文件不存在，') + (hasData ? '其中已有数据。' : '其中没有数据。'));
  process.exit(0);
}

const t0 = Date.now();
store.importAll(db);
const ms = Date.now() - t0;
console.log('导入完成 ' + ms + 'ms');

const v = store.verify(db);
if (!v.ok) {
  console.error('✗ 校验失败：');
  for (const p of v.problems) console.error('  · ' + p);
  process.exit(1);
}
const size = fs.statSync(SQLITE_FILE).size;
console.log('校验通过：逐行内容与 db.json 一致');
console.log('库文件 ' + SQLITE_FILE + '（' + (size / 1024 / 1024).toFixed(2) + ' MB）');
console.log('');
console.log('下一步：DB_ENGINE=sqlite node server.js');
console.log('提示：sqlite 引擎会按 DB_MIRROR_INTERVAL_MS（默认 5 分钟）把 db.json 镜像刷新一遍，');
console.log('      所以 tools/ops/sync-live.mjs、deploy、robustness-check 这些按 db.json 工作的老流程仍然可用。');
store.close(db);
