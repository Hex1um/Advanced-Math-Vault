#!/usr/bin/env node
/**
 * 把「旧实例上的人」合并回本地库（换实例时用户不会自动跟过来）。
 *
 *   node tools/ops/merge-users-from.mjs \
 *     --from https://math-vault-10141.app.workbuddy.host --code Q6CZHVVW3K \
 *     --user Hex1um --pass ****** [--dry]
 *
 * 背景：v3.9.0 把后端迁到新实例时，只搬了题库，用户账号 / 解题记录 / 帖子没有跟着走，
 *       新库重新初始化后只剩 admin 和几个压测号，于是首页「同学 / 做题数」对不上。
 *
 * 合并规则（保守，不覆盖新库的活跃数据）：
 *   - 用户按 id 合并，其次按 name；同名以外的新库账号一律保留
 *   - exp / solved 取并集（较大者胜），密码哈希沿用旧库（新库没有这个人才会写）
 *   - 帖子 / 提交按 id 去重后追加
 *   - 测试账号（hidden）保持 hidden，不参与首页统计
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
};
const DRY = argv.includes('--dry');

const FROM = String(flag('from', 'https://math-vault-10141.app.workbuddy.host')).replace(/\/+$/, '');
const CODE = String(flag('code', 'Q6CZHVVW3K')).trim();
const USER = String(flag('user', 'Hex1um')).trim();
const PASS = String(flag('pass', process.env.ADMIN_PASS || '')).trim();

if (!PASS) {
  console.error('✗ 需要旧实例的管理员密码：--pass ****** 或环境变量 ADMIN_PASS');
  process.exit(2);
}
if (!fs.existsSync(DB_FILE)) {
  console.error('✗ 找不到 ' + DB_FILE + '（先跑一次服务或 pull-live-db）');
  process.exit(2);
}

const u = (p) => FROM + p + (p.includes('?') ? '&' : '?') + 'sharecode=' + encodeURIComponent(CODE);

async function main() {
  const res = await fetch(u('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: USER, password: PASS })
  });
  const login = await res.json().catch(() => ({}));
  if (!res.ok || !login.ok) throw new Error('旧实例登录失败: ' + (login.error || res.status));
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const cookie = raw.map((c) => String(c).split(';')[0]).filter(Boolean).join('; ');

  const exp = await fetch(u('/api/admin/export?withUsers=1'), { headers: { cookie } });
  if (!exp.ok) throw new Error('旧实例导出失败: HTTP ' + exp.status);
  const old = await exp.json();

  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db.users = db.users || [];
  db.posts = db.posts || [];
  db.submissions = db.submissions || [];

  const before = {
    users: db.users.length,
    visible: db.users.filter((x) => !x.hidden).length,
    solved: db.users.filter((x) => !x.hidden).reduce((s, x) => s + Object.keys(x.solved || {}).length, 0),
    posts: db.posts.length,
    submissions: db.submissions.length
  };

  const byId = new Map(db.users.map((x) => [x.id, x]));
  const byName = new Map(db.users.map((x) => [String(x.name).toLowerCase(), x]));
  const added = [];
  const merged = [];

  for (const ou of old.users || []) {
    const hit = byId.get(ou.id) || byName.get(String(ou.name).toLowerCase());
    if (!hit) {
      db.users.push(ou);
      byId.set(ou.id, ou);
      byName.set(String(ou.name).toLowerCase(), ou);
      added.push(ou.name);
      continue;
    }
    /* 合并：经验取大、solved 取并集，其余以「旧账号的记录」为准补空字段 */
    hit.exp = Math.max(Number(hit.exp) || 0, Number(ou.exp) || 0);
    hit.solved = Object.assign({}, ou.solved || {}, hit.solved || {});
    hit.wrong = Object.assign({}, ou.wrong || {}, hit.wrong || {});
    for (const k of ['salt', 'passhash', 'createdAt', 'email', 'emailVerified', 'role']) {
      if (hit[k] === undefined && ou[k] !== undefined) hit[k] = ou[k];
    }
    if (!hit.role || hit.role === 'user') {
      if (ou.role === 'admin') hit.role = 'admin';
    }
    merged.push(hit.name);
  }

  /* 每日一积的历史记录（db.daily 是「某天出过哪道题」的缓存）：只补缺失的日期，
     不覆盖新库已有的（新库算过的那天就以它为准）。 */
  db.daily = db.daily || {};
  let dailyAdded = 0;
  for (const [k, v] of Object.entries(old.daily || {})) {
    if (!db.daily[k] && db.problems.some((p) => p.code === v)) { db.daily[k] = v; dailyAdded++; }
  }

  const postIds = new Set(db.posts.map((p) => p.id));
  let postsAdded = 0;
  for (const p of old.posts || []) if (!postIds.has(p.id)) { db.posts.push(p); postsAdded++; }

  const subIds = new Set(db.submissions.map((s) => s.id));
  let subsAdded = 0;
  for (const s of old.submissions || []) if (!subIds.has(s.id)) { db.submissions.push(s); subsAdded++; }

  const after = {
    users: db.users.length,
    visible: db.users.filter((x) => !x.hidden).length,
    solved: db.users.filter((x) => !x.hidden).reduce((s, x) => s + Object.keys(x.solved || {}).length, 0),
    posts: db.posts.length,
    submissions: db.submissions.length
  };

  console.log('旧实例: ' + FROM);
  console.log('  用户 ' + (old.users || []).length + ' / 帖子 ' + (old.posts || []).length + ' / 提交 ' + (old.submissions || []).length);
  console.log('本地（前）: ' + JSON.stringify(before));
  console.log('新增用户: ' + (added.join(', ') || '—'));
  console.log('合并用户: ' + (merged.join(', ') || '—'));
  console.log('新增帖子 ' + postsAdded + ' / 新增提交 ' + subsAdded + ' / 补齐每日一积 ' + dailyAdded + ' 天');
  console.log('本地（后）: ' + JSON.stringify(after));

  if (DRY) { console.log('--dry：未写盘'); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(DB_FILE, DB_FILE + '.before-merge-' + stamp);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
  console.log('已写入 ' + path.relative(ROOT, DB_FILE) + '（备份 .before-merge-' + stamp + '）');
}

main().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
