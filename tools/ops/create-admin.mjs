#!/usr/bin/env node
/**
 * 创建（或重置）一个管理员账号
 * 用法：node tools/ops/create-admin.mjs <用户名> <密码>
 * 需要先停掉服务，脚本直接改 data/db.json
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');

const [name, password] = process.argv.slice(2);
if (!name || !password) {
  console.error('用法: node tools/ops/create-admin.mjs <用户名> <密码>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('密码至少 8 位');
  process.exit(1);
}
if (!fs.existsSync(DB_FILE)) {
  console.error('找不到 ' + DB_FILE + '，先启动一次服务初始化数据库');
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
db.users = db.users || [];

const salt = crypto.randomBytes(16).toString('hex');
const passHash = crypto.scryptSync(String(password), salt, 64).toString('hex');

const existing = db.users.find((u) => u.name.toLowerCase() === name.toLowerCase());
if (existing) {
  existing.salt = salt;
  existing.passHash = passHash;
  existing.role = 'admin';
  console.log('已重置管理员 ' + existing.name + ' 的密码');
} else {
  db.users.push({
    id: crypto.randomUUID(),
    name,
    salt,
    passHash,
    role: 'admin',
    exp: 0,
    solved: {},
    activity: [],
    createdAt: new Date().toISOString()
  });
  console.log('已创建管理员 ' + name);
}

fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
fs.renameSync(DB_FILE + '.tmp', DB_FILE);
console.log('管理员数量:', db.users.filter((u) => u.role === 'admin').length);
