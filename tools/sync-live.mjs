#!/usr/bin/env node
/**
 * 部署前把线上的「用户 / 帖子 / 反馈 / 每日记录」合并回本地 data/db.json。
 *
 * 为什么需要：站点部署是把整个目录上传覆盖，本地 db.json 会替换线上 db.json。
 * 如果本地库是干净的（比如刚导入完题库），一部署就把线上用户的帖子和经验冲掉了。
 * 所以每次部署前必须先跑这个脚本，把线上用户数据并进本地，再部署。
 *
 * 用法：
 *   node tools/sync-live.mjs                     # 合并到本地 data/db.json
 *   node tools/sync-live.mjs --dry               # 只看差异，不写盘
 *   BASE=... SHARECODE=... ADMIN_USER=... ADMIN_PASS=... node tools/sync-live.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const BASE = (process.env.BASE || 'https://math-vault-10141.app.workbuddy.host').replace(/\/$/, '');
const SHARECODE = process.env.SHARECODE || 'Q6CZHVVW3K';
const USER = process.env.ADMIN_USER || 'Hex1um';
const PASS = process.env.ADMIN_PASS || 'REPLACE_WITH_ADMIN_PASS';
const DRY = process.argv.includes('--dry');

function log(...a) { console.log(...a); }

async function login() {
  const res = await fetch(BASE + '/api/auth/login?sharecode=' + SHARECODE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: USER, password: PASS })
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch (_) {}
  if (!res.ok || !j || !j.ok) throw new Error('登录失败: ' + res.status + ' ' + text.slice(0, 160));
  // 多个 Set-Cookie（网关 __wb_rsc + 站点 mv_session）要一起带上，只取第一个会丢掉会话
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  const cookie = list.map((s) => String(s || '').split(';')[0]).filter(Boolean).join('; ');
  if (!cookie) throw new Error('登录成功但没拿到会话 cookie');
  return cookie;
}

async function exportLive(cookie) {
  const res = await fetch(BASE + '/api/admin/export?withUsers=1&sharecode=' + SHARECODE, {
    headers: { cookie }
  });
  if (!res.ok) throw new Error('导出失败 ' + res.status);
  return await res.json();
}

function byKey(list, key) {
  const m = new Map();
  for (const x of list || []) if (x && x[key] !== undefined) m.set(String(x[key]), x);
  return m;
}

function main() {
  return (async () => {
    log('线上:', BASE);
    const cookie = await login();
    const live = await exportLive(cookie);
    if (!fs.existsSync(DB_FILE)) throw new Error('本地库不存在: ' + DB_FILE);
    const local = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

    const liveUsers = live.users || [];
    // 测试脚本留下的账号不要同步回本地（darktest / u12345 这类）
    const TEST_USER = /^(darktest|test\w*|u\d{5})$/i;
    const skipped = liveUsers.filter((u) => TEST_USER.test(u.name || ''));
    const keepUsers = liveUsers.filter((u) => !TEST_USER.test(u.name || ''));
    if (skipped.length) log(`跳过测试账号 ${skipped.length} 个: ${skipped.map((u) => u.name).join(', ')}`);
    const livePosts = live.posts || [];
    const liveFb = live.feedbacks || [];
    const liveDaily = live.daily || {};
    const liveProblems = live.problems || [];

    log(`线上: 用户 ${keepUsers.length} / 帖子 ${livePosts.length} / 反馈 ${liveFb.length} / 题 ${liveProblems.length}`);
    log(`本地: 用户 ${(local.users || []).length} / 帖子 ${(local.posts || []).length} / 反馈 ${(local.feedbacks || []).length} / 题 ${(local.problems || []).length}`);

    /* 用户：以 id 为准，线上的经验/做题记录为准；本地独有的用户保留 */
    const lUsers = byKey(local.users, 'id');
    let addedUsers = 0, updatedUsers = 0;
    for (const u of keepUsers) {
      const cur = lUsers.get(String(u.id));
      if (!cur) { (local.users = local.users || []).push(u); addedUsers++; continue; }
      // 线上有活动就用线上的，避免本地空壳把线上经验冲掉
      const liveHasData = (u.exp || 0) > 0 || Object.keys(u.solved || {}).length > 0 || (u.activity || []).length > 0;
      const localHasData = (cur.exp || 0) > 0 || Object.keys(cur.solved || {}).length > 0;
      if (liveHasData && !localHasData) { Object.assign(cur, u); updatedUsers++; }
      else if (!cur.passhash && u.passhash) { cur.passhash = u.passhash; updatedUsers++; }
    }

    /* 帖子：以 id 为准，两边并集（线上为主，本地独有的补上） */
    const lPosts = byKey(local.posts, 'id');
    let addedPosts = 0;
    for (const p of livePosts) {
      const cur = lPosts.get(String(p.id));
      if (!cur) { (local.posts = local.posts || []).push(p); addedPosts++; }
      else {
        // 回复数更多/更新时间更晚的一版更完整
        const a = (p.replies || []).length, b = (cur.replies || []).length;
        if (a > b || String(p.updatedAt || '') > String(cur.updatedAt || '')) Object.assign(cur, p);
      }
    }

    /* 反馈：并集 */
    const lFb = byKey(local.feedbacks, 'id');
    let addedFb = 0;
    for (const f of liveFb) {
      if (!lFb.has(String(f.id))) { (local.feedbacks = local.feedbacks || []).push(f); addedFb++; }
    }

    /* 每日记录：按日期键合并 */
    local.daily = Object.assign({}, liveDaily, local.daily || {});

    /* 题目统计：把线上的做题人数/评分带过来（题本体以本地为准，本地才有新导入的题） */
    const liveP = byKey(liveProblems, 'code');
    let stats = 0;
    for (const p of local.problems || []) {
      const o = liveP.get(String(p.code));
      if (!o) continue;
      if ((o.solvedCount || 0) > (p.solvedCount || 0) || (o.attemptCount || 0) > (p.attemptCount || 0)) {
        p.solvedCount = o.solvedCount || 0;
        p.attemptCount = o.attemptCount || 0;
        p.scoreSum = o.scoreSum || 0;
        p.scoreCount = o.scoreCount || 0;
        stats++;
      }
    }

    /* 计数器不要倒退 */
    const lm = live.meta || {};
    local.meta = Object.assign({}, local.meta);
    for (const k of ['seq', 'postSeq', 'replySeq', 'feedbackSeq']) {
      const a = Number(lm[k] || 0), b = Number(local.meta[k] || 0);
      if (a > b) local.meta[k] = a;
    }

    log(`合并: 新增用户 ${addedUsers} / 更新用户 ${updatedUsers} / 新增帖子 ${addedPosts} / 新增反馈 ${addedFb} / 题目统计 ${stats}`);
    if (DRY) { log('--dry：未写盘'); return; }

    const bak = DB_FILE + '.before-sync-' + Date.now() + '.json';
    fs.copyFileSync(DB_FILE, bak);
    fs.writeFileSync(DB_FILE, JSON.stringify(local, null, 2), 'utf8');
    log('已写盘:', DB_FILE);
    log('原文件备份:', path.basename(bak));
    log(`最终: 用户 ${local.users.length} / 帖子 ${local.posts.length} / 题 ${local.problems.length}`);
  })();
}

main().catch((e) => { console.error('同步失败:', e.message); process.exit(1); });
