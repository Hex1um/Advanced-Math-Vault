#!/usr/bin/env node
/**
 * 把线上整库拉回本地（题目 + 用户 + 帖子 + 每日记录 + 提交 + 反馈）。
 *
 *   node tools/ops/pull-live-db.mjs            # 拉下来覆盖 data/db.json（先自动备份）
 *   node tools/ops/pull-live-db.mjs --dry      # 只比对数量，不写盘
 *
 * 为什么需要它：deploy.mjs 是「同步用户 → 上传整个 db.json」，
 * 如果本地库比线上旧（换过实例、别人扩过题），上传就是把线上题库覆盖回旧版本。
 * 发布前必须先把线上整库拉回来，本地才是「线上 + 我的改动」。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const DRY = process.argv.includes('--dry');

const cfgFile = path.join(ROOT, 'deploy.config.json');
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
const BASE = String(process.env.BASE || cfg.apiBase || '').replace(/\/+$/, '');
const SHARECODE = String(process.env.SHARECODE || cfg.sharecode || '').trim();
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || '';

if (!BASE) {
  console.error('✗ 没有后端地址：设置 BASE 或在 deploy.config.json 里写 apiBase');
  process.exit(2);
}
if (!SHARECODE || !PASS) {
  console.error('✗ 需要 SHARECODE 与 ADMIN_PASS（环境变量或 ~/.math-vault-deploy.env）');
  process.exit(2);
}

const url = (p) => BASE + p + (p.includes('?') ? '&' : '?') + 'sharecode=' + encodeURIComponent(SHARECODE);

async function login() {
  const res = await fetch(url('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: USER, password: PASS })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error('登录失败: ' + (json.error || res.status));
  /* 网关会同时下发 __wb_rsc 与 mv_session 两个 cookie，只带后者会被挡成 403 */
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  const cookie = raw.map((c) => String(c).split(';')[0]).filter(Boolean).join('; ');
  if (!cookie) throw new Error('登录没有拿到 cookie');
  return cookie;
}

function nextSeq(problems) {
  let max = 1000;
  for (const p of problems) {
    const m = /^[A-Z]+(\d+)$/.exec(String(p.code || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

(async () => {
  console.log('▶ 线上: ' + BASE + '  用户: ' + USER);
  const cookie = await login();
  const res = await fetch(url('/api/admin/export?withUsers=1'), { headers: { cookie } });
  if (!res.ok) throw new Error('导出失败: HTTP ' + res.status);
  const live = await res.json();
  if (!Array.isArray(live.problems) || !live.problems.length) throw new Error('线上导出里没有题目');

  const local = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : {};
  const count = (d) => ({
    problems: (d.problems || []).length,
    users: (d.users || []).length,
    posts: (d.posts || []).length,
    daily: Object.keys(d.daily || {}).length,
    submissions: (d.submissions || []).length,
    feedbacks: (d.feedbacks || []).length
  });
  const a = count(local);
  const b = count(live);
  console.log('  本地: ' + JSON.stringify(a));
  console.log('  线上: ' + JSON.stringify(b));

  const bySubject = {};
  for (const p of live.problems) bySubject[p.subject || 'math'] = (bySubject[p.subject || 'math'] || 0) + 1;
  console.log('  线上学科分布: ' + JSON.stringify(bySubject));

  if (DRY) {
    console.log('--dry：未写盘');
    return;
  }

  const merged = Object.assign({}, local);
  for (const k of ['problems', 'users', 'posts', 'daily', 'feedbacks', 'submissions']) {
    if (live[k] !== undefined) merged[k] = live[k];
  }
  merged.meta = merged.meta || {};
  merged.meta.seq = nextSeq(merged.problems);
  merged.meta.postSeq = Math.max(Number(merged.meta.postSeq) || 1, ...(merged.posts || []).map((p) => (Number(p.id) || 0) + 1));
  merged.meta.feedbackSeq = Math.max(Number(merged.meta.feedbackSeq) || 1, ...(merged.feedbacks || []).map((f) => (Number(f.id) || 0) + 1));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (fs.existsSync(DB_FILE)) {
    const bak = DB_FILE + '.before-pull-' + stamp;
    fs.copyFileSync(DB_FILE, bak);
    console.log('  已备份旧库 → ' + path.relative(ROOT, bak));
  }
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, DB_FILE);
  console.log('  已写入 ' + path.relative(ROOT, DB_FILE) + '（meta.seq=' + merged.meta.seq + '）');
})().catch((e) => {
  console.error('✗ ' + e.message);
  process.exit(1);
});
