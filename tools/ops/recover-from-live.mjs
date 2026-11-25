#!/usr/bin/env node
/**
 * 从线上站点抓取内容，重建本地库（迁移/灾备用）
 *
 *   node tools/ops/recover-from-live.mjs                    # 抓取 → data/recovered.json
 *   node tools/ops/recover-from-live.mjs --build            # 再生成 data/db.json（含管理员）
 *   OLD_BASE=... OLD_SHARE=... ADMIN_PASS=... node tools/ops/recover-from-live.mjs --build
 *
 * 为什么需要：站点数据只存在「那一次部署的目录」里，换目录部署就是另一个实例。
 * 一旦本地 db.json 丢失、又没有管理员凭据，部署流程（先同步再覆盖）就没法启动，
 * 剩下唯一的读取面是公开接口：
 *   /api/problems（列表，含三维评分与做题统计）
 *   /api/problems/:code（题干、提示）
 *   POST /api/problems/:code/reveal（答案与解析，匿名也可读）
 *   /api/forum、/api/leaderboard、/api/daily
 *
 * 抓不到的东西：账号密码、作答明细、待审投稿、图片附件。这些只能从备份恢复。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OLD_BASE = (process.env.OLD_BASE || 'https://math-vault-10141.app.workbuddy.host').replace(/\/$/, '');
const SHARE = process.env.OLD_SHARE || 'Q6CZHVVW3K';
const OUT = process.env.OUT || path.join(ROOT, 'data', 'recovered.json');
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const CONC = Math.max(1, Number(process.env.CONC || 6));
const BUILD = process.argv.includes('--build');

function q(url) {
  return url + (url.includes('?') ? '&' : '?') + 'sharecode=' + encodeURIComponent(SHARE);
}

async function req(url, opts, tries) {
  const n = tries === undefined ? 3 : tries;
  for (let i = 0; i < n; i++) {
    try {
      const res = await fetch(q(url), Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      if (res.ok && json && json.ok !== false) return json;
      if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 120));
    } catch (e) {
      if (i === n - 1) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
}

async function pool(items, worker, conc) {
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: conc }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
      done++;
      if (done % 200 === 0) console.log('  进度 ' + done + '/' + items.length);
    }
  });
  await Promise.all(workers);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}

async function scrape() {
  console.log('源站 ' + OLD_BASE + '（sharecode ' + SHARE.slice(0, 4) + '…）');
  const listed = [];
  let total = 0;
  for (let page = 1; page <= 1000; page++) {
    const d = await req(OLD_BASE + '/api/problems?size=50&page=' + page);
    total = d.total || 0;
    listed.push(...(d.items || []));
    if (!d.items || !d.items.length || listed.length >= total) break;
    if (page % 20 === 0) console.log('  列表 ' + listed.length + '/' + total);
  }
  console.log('列表完成：' + listed.length + ' 题（服务端 total=' + total + '）');

  const details = new Map();
  await pool(listed, async (item) => {
    const code = item.code;
    try {
      const d = await req(OLD_BASE + '/api/problems/' + encodeURIComponent(code));
      const r = await req(OLD_BASE + '/api/problems/' + encodeURIComponent(code) + '/reveal', { method: 'POST', body: '{}' });
      details.set(code, Object.assign({}, d.problem || {}, { answer: r.answer || '', solution: r.solution || '', hints: r.hints || d.problem.hints || [] }));
    } catch (e) {
      console.warn('  ! ' + code + ' 抓取失败：' + e.message);
    }
  }, CONC);
  console.log('详情+答案完成：' + details.size + ' 题');

  const problems = listed.map((it) => {
    const d = details.get(it.code) || {};
    return Object.assign({}, it, d, { code: it.code, status: 'approved' });
  });

  const forum = await req(OLD_BASE + '/api/forum?size=50&page=1').catch(() => ({ items: [] }));
  const posts = [];
  for (const p of forum.items || []) {
    try {
      const d = await req(OLD_BASE + '/api/forum/' + p.id);
      posts.push(d.post || d);
    } catch (e) {
      posts.push({ id: p.id, title: p.title, authorName: p.authorName, excerpt: p.excerpt, replies: [] });
    }
  }
  console.log('答疑区：' + posts.length + ' 帖');

  const board = await req(OLD_BASE + '/api/leaderboard').catch(() => ({ items: [] }));
  const daily = await req(OLD_BASE + '/api/daily').catch(() => null);

  const payload = { fetchedAt: new Date().toISOString(), source: OLD_BASE, total, problems, posts, users: board.items || [], daily: daily && daily.problem ? { [daily.date]: daily.problem.code } : {} };
  fs.writeFileSync(OUT, JSON.stringify(payload), 'utf8');
  console.log('已写入 ' + OUT + '（' + (fs.statSync(OUT).size / 1024 / 1024).toFixed(1) + ' MB）');
  return payload;
}

function build(payload) {
  const adminName = process.env.ADMIN_USER || 'Hex1um';
  const adminPass = process.env.ADMIN_PASS || '';
  const sharedPass = process.env.SHARED_PASS || '';
  if (!adminPass) {
    console.error('✗ 需要 ADMIN_PASS：新库里管理员要有一个可用密码');
    process.exit(2);
  }

  const problems = payload.problems.map((p) => {
    const scoreCount = Number(p.scoreCount) || 0;
    const avg = Number(p.avgScore) || 0;
    const out = {
      code: p.code,
      title: p.title || '',
      statement: p.statement || '',
      mainTag: p.mainTag || '综合',
      tags: Array.isArray(p.tags) ? p.tags : [],
      examTags: Array.isArray(p.examTags) ? p.examTags : [],
      kind: p.kind || '',
      thinking: Number(p.thinking) || 6,
      difficulty: Number(p.difficulty) || 6,
      calc: Number(p.calc) || 5,
      source: p.source || '',
      hints: Array.isArray(p.hints) ? p.hints : [],
      answer: p.answer || '',
      solution: p.solution || '',
      status: 'approved',
      authorId: null,
      authorName: p.authorName || '题库组',
      rejectReason: '',
      createdAt: p.createdAt || new Date().toISOString(),
      reviewedAt: p.createdAt || new Date().toISOString(),
      solvedCount: Number(p.solvedCount) || 0,
      attemptCount: Number(p.attemptCount) || 0,
      scoreSum: Math.round(avg * scoreCount),
      scoreCount
    };
    return out;
  });

  const users = [];
  for (const u of payload.users || []) {
    const isAdmin = String(u.name).toLowerCase() === adminName.toLowerCase();
    const pw = isAdmin ? adminPass : (sharedPass || crypto.randomBytes(18).toString('hex'));
    const h = hashPassword(pw);
    users.push({
      id: u.id || crypto.randomUUID(),
      name: u.name,
      email: '',
      emailVerified: false,
      salt: h.salt,
      passHash: h.hash,
      role: isAdmin ? 'admin' : (u.role === 'admin' ? 'user' : (u.role || 'user')),
      exp: Number(u.exp) || 0,
      attempts: Number(u.attempts) || 0,
      solved: {},
      best: {},
      wrong: {},
      activity: [],
      createdAt: u.createdAt || new Date().toISOString()
    });
  }
  if (!users.some((u) => u.role === 'admin')) {
    const h = hashPassword(adminPass);
    users.push({ id: crypto.randomUUID(), name: adminName, email: '', emailVerified: false, salt: h.salt, passHash: h.hash, role: 'admin', exp: 0, attempts: 0, solved: {}, best: {}, wrong: {}, activity: [], createdAt: new Date().toISOString() });
  }

  const posts = (payload.posts || []).map((p) => ({
    id: Number(p.id),
    authorId: p.authorId || null,
    authorName: p.authorName || '匿名',
    title: p.title || '',
    body: p.body || p.excerpt || '',
    problemCode: p.problemCode || '',
    images: p.images || [],
    replies: (p.replies || []).map((r) => ({
      id: Number(r.id), authorId: r.authorId || null, authorName: r.authorName || '匿名',
      isAI: !!r.isAI, replyTo: r.replyTo || null, body: r.body || '', createdAt: r.createdAt || ''
    })),
    solved: !!p.solved,
    createdAt: p.createdAt || new Date().toISOString(),
    updatedAt: p.updatedAt || p.createdAt || ''
  }));

  const maxProblemNum = problems.reduce((m, p) => {
    const n = Number(String(p.code).replace(/\D/g, ''));
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 1000);
  const maxPostId = posts.reduce((m, p) => Math.max(m, p.id || 0), 0);
  const maxReplyId = posts.reduce((m, p) => Math.max(m, ...(p.replies || []).map((r) => Number(r.id) || 0), 0), 0);

  const db = {
    users,
    problems,
    posts,
    sessions: {},
    daily: payload.daily || {},
    submissions: [],
    feedbacks: [],
    emailCodes: {},
    settings: {
      llm: {
        baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
        model: process.env.LLM_MODEL || 'deepseek-chat',
        apiKey: process.env.LLM_API_KEY || ''
      },
      site: '数海晴岸'
    },
    meta: { seq: maxProblemNum + 1, postSeq: maxPostId + 1, replySeq: maxReplyId + 1, feedbackSeq: 1 }
  };

  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  console.log('已生成 ' + DB_FILE);
  console.log('  题 ' + problems.length + ' · 用户 ' + users.length + '（管理员 ' + users.filter((u) => u.role === 'admin').length + '）'
    + ' · 帖 ' + posts.length + ' · 回复 ' + posts.reduce((s, p) => s + p.replies.length, 0));
  const noAnswer = problems.filter((p) => !p.answer).length;
  const noSolution = problems.filter((p) => !p.solution).length;
  if (noAnswer || noSolution) console.log('  ⚠ 缺答案 ' + noAnswer + ' 题、缺解析 ' + noSolution + ' 题');
}

const payload = BUILD && fs.existsSync(OUT) && !process.argv.includes('--rescrape')
  ? JSON.parse(fs.readFileSync(OUT, 'utf8'))
  : await scrape();
if (BUILD) build(payload);
