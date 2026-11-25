#!/usr/bin/env node
/**
 * 手动备份当前库
 *
 *   node tools/ops/backup-db.mjs                 # 归档到 data/backups/daily/
 *   node tools/ops/backup-db.mjs --label before-import
 *   node tools/ops/backup-db.mjs --keep 30       # 只保留最近 30 天
 *   node tools/ops/backup-db.mjs --sqlite data/db.sqlite --json data/db.json
 *
 * 进程内已经有每日自动归档（server.js 启动时 + 每 30 分钟检查跨天），这个脚本
 * 是给「导入题库 / 手工改库 / 迁移前」这种人为操作前用的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
};

const DB_FILE = path.resolve(flag('json', process.env.DB_FILE || path.join(ROOT, 'data', 'db.json')));
const SQLITE_FILE = path.resolve(flag('sqlite', DB_FILE.replace(/\.json$/i, '') + '.sqlite'));
const KEEP = Math.max(2, Number(flag('keep', process.env.BACKUP_KEEP || 14)));
const LABEL = String(flag('label', '')).replace(/[^\w.-]+/g, '');
const OUT_DIR = path.resolve(flag('out', path.join(ROOT, 'data', 'backups', 'daily')));

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const suffix = stamp + (LABEL ? '-' + LABEL : '');

let done = 0;

if (fs.existsSync(SQLITE_FILE)) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const sdb = new DatabaseSync(SQLITE_FILE);
    try { sdb.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
    sdb.close();
  } catch (e) {
    console.warn('! 无法 checkpoint sqlite（WAL 里的最新行可能没进备份）:', e.message);
  }
  const dest = path.join(OUT_DIR, 'db-' + suffix + '.sqlite');
  fs.copyFileSync(SQLITE_FILE, dest);
  console.log('已备份 SQLite → ' + dest + '（' + (fs.statSync(dest).size / 1024 / 1024).toFixed(2) + ' MB）');
  done++;
}

if (fs.existsSync(DB_FILE)) {
  const dest = path.join(OUT_DIR, 'db-' + suffix + '.json');
  fs.copyFileSync(DB_FILE, dest);
  console.log('已备份 JSON   → ' + dest + '（' + (fs.statSync(dest).size / 1024 / 1024).toFixed(2) + ' MB）');
  done++;
}

if (!done) {
  console.error('✗ 既没有 ' + SQLITE_FILE + ' 也没有 ' + DB_FILE + '，无从备份');
  process.exit(2);
}

/* 按日期字符裁剪：同名日期只留最新一份 */
const files = fs.readdirSync(OUT_DIR).filter((f) => /^db-\d{4}-\d{2}-\d{2}/.test(f));
const dates = [...new Set(files.map((f) => f.slice(3, 13)))].sort();
let removed = 0;
while (dates.length > KEEP) {
  const drop = dates.shift();
  for (const f of files.filter((x) => x.slice(3, 13) === drop)) {
    try { fs.unlinkSync(path.join(OUT_DIR, f)); removed++; } catch (e) {}
  }
}
console.log('保留最近 ' + KEEP + ' 天' + (removed ? '，清理旧备份 ' + removed + ' 个' : ''));
