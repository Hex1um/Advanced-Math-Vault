#!/usr/bin/env node
/**
 * 手动备份当前库（热备份 + 完整性校验）
 *
 *   node tools/ops/backup-db.mjs                       # 归档到 data/backups/daily/
 *   node tools/ops/backup-db.mjs --label pre-deploy
 *   node tools/ops/backup-db.mjs --keep 30
 *   node tools/ops/backup-db.mjs --sqlite data/db.sqlite --json data/db.json
 *   node tools/ops/backup-db.mjs --include-uploads      # 连 data/uploads 一起归档
 *
 * 为什么不直接 copyFileSync：
 *   服务在跑的时候直接拷 SQLite 主文件，可能拷到「写了一半」的状态，而且 WAL 里的
 *   最新行还在 -wal 文件里。这里改成 `VACUUM INTO`——SQLite 自带的事务级热备份，
 *   不需要停服。备份完成后立刻校验：SQLite 跑 PRAGMA integrity_check 必须返回 ok，
 *   JSON 必须能被 JSON.parse 完整解析（防截断）。
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
const has = (name) => argv.includes('--' + name);

const DB_FILE = path.resolve(flag('json', process.env.DB_FILE || path.join(ROOT, 'data', 'db.json')));
const SQLITE_FILE = path.resolve(flag('sqlite', DB_FILE.replace(/\.json$/i, '') + '.sqlite'));
const KEEP = Math.max(2, Number(flag('keep', process.env.BACKUP_KEEP || 14)));
const LABEL = String(flag('label', '')).replace(/[^\w.-]+/g, '');
const OUT_DIR = path.resolve(flag('out', path.join(ROOT, 'data', 'backups', 'daily')));
const UPLOAD_DIR = path.resolve(flag('uploads', path.join(ROOT, 'data', 'uploads')));
const INCLUDE_UPLOADS = has('include-uploads');

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const suffix = stamp + (LABEL ? '-' + LABEL : '');

let done = 0;
let failed = 0;

const human = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' MB';

function verifySqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    const v = row && (row.integrity_check !== undefined ? row.integrity_check : Object.values(row)[0]);
    return String(v).toLowerCase() === 'ok';
  } finally {
    try { db.close(); } catch (e) {}
  }
}

/* ---------------- SQLite：VACUUM INTO 热备份 ---------------- */
if (fs.existsSync(SQLITE_FILE)) {
  const dest = path.join(OUT_DIR, 'db-' + suffix + '.sqlite');
  try {
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (e) {}
    const { DatabaseSync } = require('node:sqlite');
    const sdb = new DatabaseSync(SQLITE_FILE);
    try {
      // 目标路径里的单引号要转义，避免拼出来的 SQL 被截断
      sdb.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'");
    } finally {
      try { sdb.close(); } catch (e) {}
    }
    if (!verifySqlite(dest)) {
      failed++;
      console.error('✗ SQLite 备份完整性校验失败：' + dest);
    } else {
      console.log('已备份 SQLite → ' + dest + '（' + human(fs.statSync(dest).size) + '，integrity_check=ok）');
      done++;
    }
  } catch (e) {
    failed++;
    console.error('✗ SQLite 热备份失败：' + e.message);
  }
}

/* ---------------- JSON：复制后 JSON.parse 校验 ---------------- */
if (fs.existsSync(DB_FILE)) {
  const dest = path.join(OUT_DIR, 'db-' + suffix + '.json');
  try {
    fs.copyFileSync(DB_FILE, dest);
    JSON.parse(fs.readFileSync(dest, 'utf8')); // 截断会在这里抛
    console.log('已备份 JSON   → ' + dest + '（' + human(fs.statSync(dest).size) + '，JSON 可解析）');
    done++;
  } catch (e) {
    failed++;
    console.error('✗ JSON 备份校验失败：' + e.message);
  }
}

/* ---------------- 可选：一并归档用户上传的图片 ---------------- */
if (INCLUDE_UPLOADS) {
  if (!fs.existsSync(UPLOAD_DIR)) {
    console.log('（没有 ' + UPLOAD_DIR + '，跳过图片归档）');
  } else {
    const dest = path.join(OUT_DIR, 'uploads-' + suffix);
    let files = 0;
    let bytes = 0;
    (function copy(from, to) {
      fs.mkdirSync(to, { recursive: true });
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const a = path.join(from, entry.name);
        const b = path.join(to, entry.name);
        if (entry.isDirectory()) copy(a, b);
        else { fs.copyFileSync(a, b); files++; bytes += fs.statSync(b).size; }
      }
    })(UPLOAD_DIR, dest);
    console.log('已归档上传目录 → ' + dest + '（' + files + ' 个文件，' + human(bytes) + '）');
    done++;
  }
}

if (!done && !failed) {
  console.error('✗ 既没有 ' + SQLITE_FILE + ' 也没有 ' + DB_FILE + '，无从备份');
  process.exit(2);
}
if (failed) {
  console.error('✗ 有 ' + failed + ' 份备份未通过校验，请勿删除旧备份');
  process.exit(1);
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
  for (const d of fs.readdirSync(OUT_DIR, { withFileTypes: true })) {
    if (d.isDirectory() && d.name.indexOf('uploads-') === 0 && d.name.slice(8, 18) === drop) {
      try { fs.rmdirSync(path.join(OUT_DIR, d.name)); removed++; } catch (e) {}
    }
  }
}
console.log('保留最近 ' + KEEP + ' 天' + (removed ? '，清理旧备份 ' + removed + ' 个' : ''));
