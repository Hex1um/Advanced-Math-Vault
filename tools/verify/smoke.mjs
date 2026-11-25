#!/usr/bin/env node
/** 全链路冒烟测试：起一个独立端口的临时库，跑完删掉 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.env.SMOKE_PORT || 8899);
const BASE = 'http://127.0.0.1:' + PORT;
const ENGINE = (process.argv.find((a) => a.startsWith('--engine=')) || '').split('=')[1] || process.env.SMOKE_ENGINE || 'json';
const DB = path.join(ROOT, 'data', ENGINE === 'sqlite' ? '.smoke-db.sqlite' : '.smoke-db.json');
const SQLITE_FILES = [DB, DB + '-wal', DB + '-shm'];

function cleanupDb(file) {
  for (const f of [file, file + '.tmp', file + '-wal', file + '-shm']) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
  }
}

for (const f of SQLITE_FILES) {
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
}
// sqlite 引擎下 DB_FILE 仍指向 json 路径（镜像用），真正的库是 .sqlite
const DB_JSON = path.join(ROOT, 'data', '.smoke-db.json');
try { if (fs.existsSync(DB_JSON)) fs.unlinkSync(DB_JSON); } catch (e) {}

let cookie = '';
let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

async function req(pathname, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + pathname, Object.assign({}, opts, { headers }));
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, json, text, res };
}

/* 独立的会话客户端（测多角色时不互相污染 cookie） */
function client() {
  let ck = '';
  return async function (pathname, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (ck) headers.cookie = ck;
    const res = await fetch(BASE + pathname, Object.assign({}, opts, { headers }));
    const set = res.headers.get('set-cookie');
    if (set) ck = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, json, text };
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/meta');
      if (r.ok) return true;
    } catch (e) {}
    await sleep(200);
  }
  return false;
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    DB_FILE: DB_JSON,
    DB_ENGINE: ENGINE,
    DB_MIRROR_JSON: '0',
    SEED_FILE: path.join(ROOT, 'data', 'problems.seed.sample.json'),
    LLM_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    NO_FREE: '1',
    BACKUP_KEEP: '2',
    // 测试需要「首个注册账号自动成为管理员」；生产环境已禁用该后门，这里显式开开发模式
    NODE_ENV: 'development'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let bootLog = '';
child.stdout.on('data', (d) => { bootLog += d.toString(); });
child.stderr.on('data', (d) => { bootLog += d.toString(); });

try {
  if (!(await waitServer())) throw new Error('服务没有启动:\n' + bootLog);

  console.log('\n引擎: ' + ENGINE + ' | 库: ' + path.basename(DB));
  console.log('\n[1] 站点信息与种子题库');
  const meta = await req('/api/meta');
  ok('GET /api/meta', meta.json && meta.json.ok);
  const health = await req('/api/health');
  ok('GET /api/health 免登录可读', health.status === 200 && health.json && health.json.ok);
  ok('health 暴露存储引擎与邮件模式', health.json && health.json.engine === ENGINE && !!health.json.mail, JSON.stringify(health.json || {}).slice(0, 160));
  ok('health 不含任何密钥字段', health.json && !/apiKey|password|secret|passHash/i.test(health.text));
  ok('种子题目已入库（10 题）', meta.json.stats.problems === 10, '实际 ' + (meta.json && meta.json.stats.problems));
  ok('标签聚合非空', meta.json.stats.tags > 0);

  console.log('\n[2] 账号：首个账号为管理员');
  const reg = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: '测试管理员', password: 'smoke123' }) });
  ok('注册成功', reg.json && reg.json.ok, reg.text.slice(0, 120));
  ok('自动获得 admin 角色', reg.json.user && reg.json.user.role === 'admin');
  ok('会话 Cookie 已下发', /mv_session=/.test(cookie));

  const me = await req('/api/me');
  ok('GET /api/me 已登录', me.json && me.json.user && me.json.user.name === '测试管理员');

  const badPwd = await req('/api/auth/password', { method: 'POST', body: JSON.stringify({ oldPassword: 'wrong', newPassword: 'newpass123' }) });
  ok('原密码错误时拒绝改密', badPwd.status === 400);
  const chPwd = await req('/api/auth/password', { method: 'POST', body: JSON.stringify({ oldPassword: 'smoke123', newPassword: 'smoke456789' }) });
  ok('修改密码成功', chPwd.json.ok);
  const relogin = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ name: '测试管理员', password: 'smoke456789' }) });
  ok('新密码可登录', relogin.json.ok);

  console.log('\n[3] 题库列表与筛选');
  const list = await req('/api/problems?page=1&size=20');
  ok('列表返回 10 题', list.json.items.length === 10);
  const withScores = list.json.items.every((p) => p.thinking >= 1 && p.difficulty >= 1 && p.calc >= 1);
  ok('每题都有三维评分', withScores);
  ok('每题都有考点标签', list.json.items.every((p) => p.tags.length > 0));
  const filtered = await req('/api/problems?main=' + encodeURIComponent('积分'));
  ok('按主标签筛选生效', filtered.json.items.length > 0 && filtered.json.items.every((p) => p.mainTag === '积分'));
  const subFiltered = await req('/api/problems?tags=' + encodeURIComponent('定积分'));
  ok('按子标签筛选生效', subFiltered.json.items.length > 0 && subFiltered.json.items.every((p) => p.tags.includes('定积分')));
  const tree = await req('/api/meta');
  ok('meta 返回主/子标签树', Array.isArray(tree.json.tagTree) && tree.json.tagTree.length > 0
    && tree.json.tagTree.every((m) => m.name && Array.isArray(m.children)));

  console.log('\n[4] 题目详情 / 看答案 / 标记完成得经验');
  const detail = await req('/api/problems/HS1001');
  ok('详情可打开', detail.json.ok && detail.json.problem.code === 'HS1001');
  ok('详情不泄露答案', !('solution' in detail.json.problem));
  const reveal = await req('/api/problems/HS1001/reveal', { method: 'POST', body: '{}' });
  ok('查看答案返回解析', reveal.json.ok && reveal.json.solution.length > 50);
  const short = await req('/api/problems/HS1001/answer', { method: 'POST', body: JSON.stringify({ process: '1/2' }) });
  ok('过程太短被拒绝', short.status === 400, JSON.stringify(short.json).slice(0, 100));

  const wrong = await req('/api/problems/HS1001/answer', {
    method: 'POST',
    body: JSON.stringify({ process: '我先通分再用洛必达，算了两遍觉得结果应该是 x+1 这个形式，不太确定。' })
  });
  ok('过程不对不计经验', wrong.json.ok && wrong.json.verdict !== 'correct' && !wrong.json.gained, JSON.stringify(wrong.json).slice(0, 120));

  // 旧规则会扫全文数字：过程里的 0.5 恰好等于标准答案 1/2 就被判对。现在只看结论行。
  const decoy = await req('/api/problems/HS1001/answer', {
    method: 'POST',
    body: JSON.stringify({ process: '第 1 步先算 0.5，然后发现问题不对；最后重新算得到 3/4。' })
  });
  ok('过程里的无关数字不算答案', decoy.json.ok && decoy.json.verdict !== 'correct', JSON.stringify(decoy.json).slice(0, 120));

  const right = await req('/api/problems/HS1001/answer', {
    method: 'POST',
    body: JSON.stringify({ process: '先通分，再用泰勒展开：tanx-sinx 的主部是 x³/2，所以原极限等于 1/2。' })
  });
  ok('过程正确判定通过', right.json.verdict === 'correct' && right.json.gained > 0, JSON.stringify(right.json).slice(0, 120));
  ok('思路 + 正确答案直接给满分', right.json.score === 100, JSON.stringify(right.json).slice(0, 120));
  ok('看答案后经验有折扣', right.json.gained < 60);
  const right2 = await req('/api/problems/HS1001/answer', { method: 'POST', body: JSON.stringify({ process: '再交一次看看，答案还是 1/2。' }) });
  ok('同题不重复给经验', right2.json.already === true, JSON.stringify(right2.json).slice(0, 160));

  const answerOnly = await req('/api/problems/HS1002/answer', {
    method: 'POST',
    body: JSON.stringify({ mode: 'answer', answer: '$e^{-1/2}=\\dfrac{1}{\\sqrt e}$' })
  });
  ok('只交正确答案仍是 80 分', answerOnly.json.score === 80, JSON.stringify(answerOnly.json).slice(0, 160));

  // 带图片的判卷会走 VISION_MODEL 分支；曾因该 const 定义在 handleApi 内部而 TDZ 报错。
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const withImage = await req('/api/problems/HS1003/answer', {
    method: 'POST',
    body: JSON.stringify({ image: tinyPng })
  });
  ok('带图片判卷不报 TDZ/500', withImage.status === 200 && withImage.json.ok === true,
    withImage.status + ' ' + JSON.stringify(withImage.json).slice(0, 160));

  console.log('\n[5] 投稿 → 审核 → 入库');
  const submit = await req('/api/submit', {
    method: 'POST',
    body: JSON.stringify({
      title: '冒烟测试题：$\\int_0^1 x\\,dx$',
      statement: '计算 $$\\int_0^1 x\\,\\mathrm{d}x.$$',
      tags: ['定积分'],
      thinking: 3, difficulty: 3, calc: 3,
      solution: '$$\\int_0^1x\\mathrm{d}x=\\frac{1}{2}.$$',
      answer: '$\\frac12$'
    })
  });
  ok('投稿成功并拿到编号', submit.json.ok && /^HS\d+$/.test(submit.json.code), submit.text.slice(0, 120));
  const dupSubmit = await req('/api/submit', {
    method: 'POST',
    body: JSON.stringify({
      title: '冒烟测试题：$\\int_0^1 x\\,dx$（重复）',
      statement: '计算 $$\\int_0^1 x\\,\\mathrm{d}x.$$',
      tags: ['定积分'], thinking: 3, difficulty: 3, calc: 3,
      solution: '$$\\int_0^1x\\mathrm{d}x=\\frac{1}{2}.$$', answer: '$\\frac12$'
    })
  });
  ok('重复投稿被查重拦截', dupSubmit.status === 409 && dupSubmit.json && dupSubmit.json.duplicate,
    JSON.stringify(dupSubmit.json || {}).slice(0, 160));
  const pending = await req('/api/admin/pending');
  ok('待审列表有 1 题', pending.json.items.length === 1);
  ok('投稿自动归入主标签', pending.json.items[0].mainTag === '积分', JSON.stringify(pending.json.items[0]).slice(0, 160));
  ok('投稿子标签已归一化', pending.json.items[0].tags.includes('定积分'), JSON.stringify(pending.json.items[0].tags));
  const review = await req('/api/admin/review', { method: 'POST', body: JSON.stringify({ code: submit.json.code, action: 'approve', patch: { calc: 2, mainTag: '积分', tags: ['定积分', '换元与分部'] } }) });
  ok('审核通过', review.json.ok);
  const afterApprove = await req('/api/problems?size=50');
  ok('入库后总数变 11', afterApprove.json.total === 11, '实际 ' + afterApprove.json.total);
  const approved = await req('/api/problems/' + submit.json.code);
  ok('审核时修改的评分已生效', approved.json.problem.calc === 2);
  ok('审核时修改的主/子标签已生效', approved.json.problem.mainTag === '积分' && approved.json.problem.tags.includes('换元与分部'), JSON.stringify(approved.json.problem.tags));
  const bareNum = await req('/api/problems/' + submit.json.code + '/answer', {
    method: 'POST',
    body: JSON.stringify({ process: '我先把 1/2 当作中间量代进去，最后发现原式根本不成立。' })
  });
  ok('结论行的裸数字不算答案', bareNum.json.ok && bareNum.json.verdict !== 'correct', JSON.stringify(bareNum.json).slice(0, 120));

  console.log('\n[6] 每日一题（全站一致）');
  const d1 = await req('/api/daily');
  const d2 = await req('/api/daily');
  ok('每日一题存在', d1.json.problem && d1.json.problem.code);
  ok('两次请求同一天同一题', d1.json.problem.code === d2.json.problem.code);
  ok('最近七日列表非空', d1.json.recent.length > 0);

  console.log('\n[7] 答疑区：发帖 + AI 自动回帖');
  const post = await req('/api/forum', {
    method: 'POST',
    body: JSON.stringify({ title: '等价无穷小在加减法里为什么不能直接用？', body: '做到 $\\lim_{x\\to0}\\frac{\\tan x-\\sin x}{x^3}$ 时，直接把两项都换成 $x$ 得到 0，但答案不是 0。为什么？', tags: ['极限'], problemCode: 'HS1001' })
  });
  ok('发帖成功', post.json.ok && post.json.id > 0);
  let postData = null;
  for (let i = 0; i < 12; i++) {
    await sleep(700);
    const p = await req('/api/forum/' + post.json.id);
    postData = p.json.post;
    if (postData.replies.some((r) => r.isAI)) break;
  }
  ok('AI 助教已自动回帖', postData && postData.replies.some((r) => r.isAI), JSON.stringify(postData && postData.replies.length));
  const aiReply = postData.replies.find((r) => r.isAI);
  ok('AI 回帖内容非空', !!(aiReply && aiReply.body.length > 20));

  const myReply = await req('/api/forum/' + post.json.id + '/reply', { method: 'POST', body: JSON.stringify({ body: '因为加减法里等价替换会丢掉高阶项，要先合并再换。' }) });
  ok('登录用户可以回复', myReply.json.ok);

  console.log('\n[8] AI 答疑对话（SSE 流式）');
  const aiRes = await fetch(BASE + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ messages: [{ role: 'user', content: '这道题第一步该怎么下手？' }], problemCode: 'HS1003' })
  });
  ok('SSE 响应 200', aiRes.status === 200);
  const raw = await aiRes.text();
  const deltas = raw.split('\n\n').map((l) => l.trim()).filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  const text = deltas.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  ok('返回流式片段', deltas.some((e) => e.type === 'meta'));
  ok('回答正文不为空', text.length > 100, '长度 ' + text.length);
  ok('回答带考点/解答上下文', /考点|先|第一步/.test(text));
  ok('结束事件已发送', deltas.some((e) => e.type === 'done'));

  console.log('\n[9] 批量导入 + 排行榜 + 权限');
  const imp = await req('/api/admin/import', {
    method: 'POST',
    body: JSON.stringify({ problems: [{ title: '导入测试 $x^2$', statement: '求 $$\\lim_{x\\to0}x^2.$$', tags: ['极限'], thinking: 2, difficulty: 2, calc: 1, solution: '$0$' }] })
  });
  ok('批量导入成功', imp.json.ok && imp.json.added.length === 1);
  const board = await req('/api/leaderboard');
  ok('排行榜有数据', board.json.items.length >= 1 && board.json.items[0].exp > 0);
  const genPrompt = await req('/api/ai/prompt', { method: 'POST', body: JSON.stringify({ mainTag: '积分', tags: ['定积分'], thinking: 6, difficulty: 6, calc: 5 }) });
  const genSys = genPrompt.json && genPrompt.json.messages && genPrompt.json.messages[0] && genPrompt.json.messages[0].content || '';
  ok('出题 prompt 锁定结构并要求验算', /结构锁定/.test(genSys) && /验算/.test(genSys));
  const ocrPrompt = await req('/api/ai/ocr-prompt');
  ok('OCR prompt 要求两遍核对', /两遍/.test((ocrPrompt.json && ocrPrompt.json.prompt) || ''));
  const logout = await req('/api/auth/logout', { method: 'POST', body: '{}' });
  ok('退出登录', logout.json.ok);
  const meAfter = await req('/api/me');
  ok('退出后会话失效', !meAfter.json.user);
  const denied = await req('/api/admin/pending');
  ok('未登录访问管理接口被拒', denied.status === 403);

  console.log('\n[10] 题目反馈：AI 审阅后转管理员');
  await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ name: '测试管理员', password: 'smoke456789' }) });
  const fbShort = await req('/api/problems/HS1001/feedback', { method: 'POST', body: JSON.stringify({ type: 'wrong_answer', content: '错了' }) });
  ok('反馈内容过短被拒绝', fbShort.status === 400);
  const fbNoLogin = await fetch(BASE + '/api/problems/HS1001/feedback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '没有登录也要能挡住' })
  });
  ok('未登录提交反馈被拒', fbNoLogin.status === 401);
  const fb = await req('/api/problems/HS1001/feedback', {
    method: 'POST',
    body: JSON.stringify({ type: 'wrong_answer', content: '解析第二步的泰勒展开系数似乎不对，建议核对 x³ 项的符号。' })
  });
  ok('反馈提交成功', fb.json.ok && fb.json.id > 0);
  const myFb = await req('/api/problems/HS1001/feedback');
  ok('用户可查看自己的反馈', myFb.json.ok && myFb.json.items.length === 1);
  // AI 审阅是异步的（NO_FREE=1 时走本地兜底），等它完成
  let adminFb = null;
  for (let i = 0; i < 20; i++) {
    adminFb = await req('/api/admin/feedbacks');
    if (adminFb.json.items && adminFb.json.items.length) break;
    await sleep(200);
  }
  ok('管理员收到 AI 审阅后的反馈', adminFb.json.items && adminFb.json.items.length === 1, JSON.stringify(adminFb.json).slice(0, 160));
  ok('反馈带 AI 分类摘要', !!(adminFb.json.items && adminFb.json.items[0].ai && adminFb.json.items[0].ai.summary));
  ok('AI 审阅完成前不出现在管理员列表', adminFb.json.pending !== undefined);
  const fbId = adminFb.json.items[0].id;
  const handled = await req('/api/admin/feedback/' + fbId, { method: 'POST', body: JSON.stringify({ action: 'resolve', note: '已核对并修正' }) });
  ok('管理员可标记已处理', handled.json.ok);
  const fbAfter = await req('/api/admin/feedbacks');
  ok('处理后统计更新', fbAfter.json.stats.open === 0, JSON.stringify(fbAfter.json.stats));
  const reexport = await req('/api/admin/export');
  ok('导出包含反馈数据', /"feedbacks"/.test(reexport.text));

  console.log('\n[11] 社区权限 / 邮箱绑定 / 组卷');
  // 新注册一个普通用户（第一个已是管理员）
  const u2 = client();
  const reg2 = await u2('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: '普通用户' + Date.now() % 1000, password: 'smoke12345' }) });
  ok('第二个账号是普通用户', reg2.json.user && reg2.json.user.role === 'user');
  ok('默认未绑定邮箱', reg2.json.user && reg2.json.user.emailVerified === false);

  const up1 = await u2('/api/forum', { method: 'POST', body: JSON.stringify({ title: '未绑邮箱第一帖', body: '这是第一条测试正文，长度足够发帖了' }) });
  ok('未绑邮箱可以发第 1 帖', up1.json.ok);
  const up2 = await u2('/api/forum', { method: 'POST', body: JSON.stringify({ title: '未绑邮箱第二帖', body: '这是第二条测试正文，应该被限流' }) });
  ok('未绑邮箱第 2 帖被限流(429)', up2.status === 429, 'status ' + up2.status);

  const codeSend = await u2('/api/me/email/send', { method: 'POST', body: JSON.stringify({ email: 'smoke@example.com' }) });
  ok('可以发送邮箱验证码', codeSend.json.ok === true);
  ok('验证码不再随响应回显', codeSend.json.code === undefined);
  // 测试里直接读临时库拿验证码（等价于部署者看服务端日志）
  let mailCode = '';
  try {
    await sleep(900);
    if (ENGINE === 'sqlite') {
      // sqlite 引擎没有 JSON 镜像可读（测试里 DB_MIRROR_JSON=0），直接查库
      const { DatabaseSync } = await import('node:sqlite');
      const sdb = new DatabaseSync(DB);
      const row = sdb.prepare('SELECT body FROM email_codes').get();
      sdb.close();
      const rec = row ? JSON.parse(row.body) : null;
      mailCode = (rec && rec.code) || '';
    } else {
      const snap = JSON.parse(fs.readFileSync(DB, 'utf8'));
      const rec = Object.values(snap.emailCodes || {})[0];
      mailCode = (rec && rec.code) || '';
    }
  } catch (e) {}
  ok('服务端已生成验证码', /^\d{6}$/.test(mailCode), mailCode);
  const codeBad = await u2('/api/me/email/verify', { method: 'POST', body: JSON.stringify({ code: '000000' }) });
  ok('错误验证码被拒', codeBad.status === 400);
  const codeOk = await u2('/api/me/email/verify', { method: 'POST', body: JSON.stringify({ code: mailCode }) });
  ok('正确验证码绑定成功', codeOk.json.ok && codeOk.json.user.emailVerified === true);
  const up3 = await u2('/api/forum', { method: 'POST', body: JSON.stringify({ title: '绑定邮箱后发帖', body: '绑定之后应该不再受每小时限制' }) });
  ok('绑定后可以继续发帖', up3.json.ok);

  const delOther = await u2('/api/forum/1/delete', { method: 'POST', body: '{}' });
  ok('普通用户不能删别人的帖子', delOther.status === 403);
  const delOwn = await u2('/api/forum/' + up1.json.id + '/delete', { method: 'POST', body: '{}' });
  ok('可以删自己的帖子', delOwn.json.ok);

  const paperGen = await req('/api/paper/generate', { method: 'POST', body: JSON.stringify({ choice: 3, fill: 2, solution: 2 }) });
  ok('组卷接口返回题目', paperGen.json.ok && paperGen.json.total > 0, JSON.stringify(paperGen.json).slice(0, 100));
  ok('组卷按题型分组', Array.isArray(paperGen.json.parts) && paperGen.json.parts.length === 3);

  const sug = await u2('/api/forum/suggest-title', { method: 'POST', body: JSON.stringify({ body: '我算 lim x->0 (e^x-1)/x 得到 1，但答案写的是 2，不知道哪步错了' }) });
  ok('AI 起标题有返回', sug.json.ok && typeof sug.json.title === 'string', JSON.stringify(sug.json).slice(0, 100));

  console.log('\n[12] 静态资源与防缓存头');
  console.log('\n[回归] 学习闭环：复习队列 / 考点统计 / 判分申诉');
  // 构造一次「只交答案且答案是错的」：会判 wrong、记提交、进错题本
  const wrongOnly = await req('/api/problems/HS1003/answer', { method: 'POST', body: JSON.stringify({ mode: 'answer', answer: '-99999' }) });
  ok('只交错误答案判 wrong 且不及格', wrongOnly.json.verdict === 'wrong' && wrongOnly.json.passed === false, JSON.stringify(wrongOnly.json).slice(0, 120));
  const rv = await req('/api/my/review-today');
  ok('今日复习队列有到期题', rv.json && rv.json.ok && rv.json.due >= 1 && rv.json.items.length >= 1, JSON.stringify(rv.json && { due: rv.json.due }));
  ok('到期题带复习间隔', !!(rv.json.items && rv.json.items[0] && rv.json.items[0].intervalDays >= 1));

  const st = await req('/api/my/stats');
  ok('考点统计返回标签聚合', st.json && st.json.ok && Array.isArray(st.json.tags) && st.json.tags.length >= 1);
  ok('考点统计带薄弱项与推荐', Array.isArray(st.json.weakest) && Array.isArray(st.json.recommend));

  const apSub = wrongOnly.json && wrongOnly.json.submissionId;
  const ap = await req('/api/submissions/appeal', { method: 'POST', body: JSON.stringify({ submissionId: apSub, reason: '最终答案我写对了，模型把符号判错了' }) });
  ok('判分申诉创建成功', ap.json && ap.json.ok && !!ap.json.id, JSON.stringify(ap.json).slice(0, 120));
  const ap2 = await req('/api/submissions/appeal', { method: 'POST', body: JSON.stringify({ submissionId: apSub, reason: '再点一次不应该生成第二条申诉' }) });
  ok('重复申诉合并为一条', ap2.json && ap2.json.ok && ap2.json.id === ap.json.id);

  const ov = await req('/api/admin/submissions/override', { method: 'POST', body: JSON.stringify({ submissionId: apSub, score: 88, comment: '人工复核通过' }) });
  ok('管理员改分生效', ov.json && ov.json.ok && ov.json.score === 88 && ov.json.verdict === 'correct', JSON.stringify(ov.json).slice(0, 120));
  const fbLoop = await req('/api/admin/feedbacks');
  const appealHandled = (fbLoop.json.items || []).some((f) => f.submissionId === apSub && f.status === 'handled');
  ok('改分后申诉自动标记已处理', appealHandled);

  console.log('\n[回归] 每日一积');
  const daily = await req('/api/daily');
  ok('每日一积返回题目', daily.json && daily.json.ok && !!daily.json.problem, JSON.stringify(daily.json && daily.json.date));
  const dp = daily.json.problem;
  const pool = await req('/api/admin/daily/pool');
  const poolCodes = new Set(((pool.json && pool.json.items) || []).map((x) => x.code));
  // 种子库题目少，池子可能为空；有池子时必须从池子里选，且难度 ≥ 6
  ok('积分题池可读', pool.json && pool.json.ok, JSON.stringify(pool.json && { total: pool.json.total }));
  ok('每日一积优先取较难积分题', poolCodes.size < 30 || (poolCodes.has(dp.code) && dp.difficulty >= 6),
    'pool=' + poolCodes.size + ' code=' + (dp && dp.code) + ' 难度=' + (dp && dp.difficulty));
  const pick = (pool.json.items || []).find((x) => x.code !== dp.code) || (pool.json.items || [])[0];
  if (pick) {
    const setDaily = await req('/api/admin/daily', { method: 'POST', body: JSON.stringify({ date: daily.json.date, code: pick.code }) });
    ok('管理员可以换今天的题', setDaily.json && setDaily.json.ok && setDaily.json.code === pick.code);
    const daily2 = await req('/api/daily');
    ok('换题立即生效', daily2.json.problem && daily2.json.problem.code === pick.code);
    const clearDaily = await req('/api/admin/daily', { method: 'POST', body: JSON.stringify({ date: daily.json.date, clear: true }) });
    ok('可以恢复自动选择', clearDaily.json && clearDaily.json.ok);
  }

  console.log('\n[回归] OCR 坏例闭环');
  const bc = await req('/api/ai/ocr-badcase', { method: 'POST', body: JSON.stringify({ raw: 'l i m x->0 (1+x) 1/x', final: '$\\lim_{x\\to 0}(1+x)^{1/x}$', conf: 61, variant: 'sauvola' }) });
  ok('坏例采集成功', bc.json && bc.json.ok === true, JSON.stringify(bc.json).slice(0, 100));
  const bcSame = await req('/api/ai/ocr-badcase', { method: 'POST', body: JSON.stringify({ raw: 'same text', final: 'same text' }) });
  ok('未修改不计入坏例', bcSame.json && bcSame.json.skipped);
  const bcList = await req('/api/admin/ocr-badcases');
  ok('管理员可读坏例列表', bcList.json && bcList.json.ok && bcList.json.total >= 1, JSON.stringify(bcList.json && { total: bcList.json.total }).slice(0, 80));

  console.log('\n[回归] 健壮性 / 隐私 / 质量门禁');
  // P0：非法百分号编码不许把进程打死
  for (const bad of ['/%zz', '/%E0%A4%A']) {
    const r = await fetch(BASE + bad).catch((e) => ({ status: 'ERR:' + e.message }));
    ok('畸形路径 ' + bad + ' 返回 4xx', typeof r.status === 'number' && r.status >= 400 && r.status < 500, String(r.status));
  }
  const alive = await req('/api/meta');
  ok('畸形请求后服务仍存活', alive.status === 200 && alive.json && alive.json.ok);
  ok('/api/meta.site 非空', !!(alive.json && alive.json.site), JSON.stringify(alive.json && alive.json.site));

  // P1-1：公共排行榜不得泄露邮箱
  const lb = await fetch(BASE + '/api/leaderboard').then((r) => r.text());
  ok('排行榜不含 email 字段', !/"email"/.test(lb));

  // P3：注册密码下限 8 位
  const shortPwd = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: '短密码' + Date.now(), password: '123456' }) });
  ok('6 位密码注册被拒', shortPwd.status === 400, String(shortPwd.status));

  // D-3：质量门禁把可疑点打标（不阻断入库）
  const badItem = {
    title: '门禁用例 ' + Date.now(),
    statement: '求 $\\frac{1}{2}$ 的值（答案：$1/2$）',
    answer: '1/2',
    tags: ['测试'],
    thinking: 5, difficulty: 5, calc: 5
  };
  const impGate = await req('/api/admin/import', { method: 'POST', body: JSON.stringify({ problems: [badItem], status: 'pending' }) });
  const created = (impGate.json && (impGate.json.added || impGate.json.problems || impGate.json.items || []))[0] || null;
  const warns = created && created.qualityWarn;
  ok('质量门禁标记「题干含答案」', Array.isArray(warns) && warns.some((w) => /含答案/.test(w)), JSON.stringify(warns));

  const html = await fetch(BASE + '/');
  ok('首页 200', html.status === 200);
  ok('首页 no-store', /no-store/.test(html.headers.get('cache-control') || ''));
  ok('KaTeX 本地可用', (await fetch(BASE + '/vendor/katex/katex.min.js')).status === 200);
  ok('样式表 200', (await fetch(BASE + '/assets/style.css')).status === 200);

  console.log('\n[13] P0 安全：AI 接口鉴权与 SSRF');
  const anon = client();
  const aiAnon = await anon('/api/ai/prompt', { method: 'POST', body: JSON.stringify({ tags: ['极限'] }) });
  ok('未登录访问 AI 接口被拒', aiAnon.status === 401, aiAnon.text.slice(0, 100));

  let ssrfHits = 0;
  const ssrfServer = http.createServer((req2, res2) => {
    ssrfHits++;
    res2.writeHead(200, { 'Content-Type': 'application/json' });
    res2.end('{}');
  });
  await new Promise((r) => ssrfServer.listen(0, '127.0.0.1', r));
  const ssrfPort = ssrfServer.address().port;
  const attack = await req('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({
      messages: [{ role: 'user', content: '你好' }],
      llm: { baseUrl: 'http://127.0.0.1:' + ssrfPort + '/v1', apiKey: 'x' }
    })
  });
  await sleep(150);
  ssrfServer.close();
  ok('内网 baseUrl 未触发服务端请求', ssrfHits === 0, 'hits=' + ssrfHits);
  ok('非法 baseUrl 回退本地讲解', /"mode":"local"/.test(attack.text), attack.text.slice(0, 120));

  console.log('\n[14] P0 安全：X-Forwarded-For 限流绕过');
  const xffClient = client();
  let spoofBlocked = false;
  for (let i = 0; i < 12; i++) {
    const r = await xffClient('/api/auth/login', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '10.77.0.' + (i + 1) },
      body: JSON.stringify({ name: 'no-such-user', password: 'wrong-password' })
    });
    if (r.status === 429) { spoofBlocked = true; break; }
  }
  ok('伪造 XFF 不能绕过限流', spoofBlocked);

  // TRUST_PROXY=1 时才会按 XFF 分桶；用第二个端口验证开关生效
  const proxyPort = PORT + 1;
  const proxyChild = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(proxyPort), DB_FILE: DB_JSON + '.proxy', DB_ENGINE: ENGINE, DB_MIRROR_JSON: '0',
      LLM_API_KEY: '', DEEPSEEK_API_KEY: '',
      NO_FREE: '1', TRUST_PROXY: '1'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch('http://127.0.0.1:' + proxyPort + '/api/meta')).ok) { ready = true; break; } } catch (e) {}
      await sleep(200);
    }
    ok('TRUST_PROXY 服务可启动', ready);
    let bypassUnderProxy = false;
    for (let i = 0; i < 13; i++) {
      const r = await fetch('http://127.0.0.1:' + proxyPort + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.88.0.' + (i + 1) },
        body: JSON.stringify({ name: 'no-such-user', password: 'wrong-password' })
      });
      if (r.status === 429) { bypassUnderProxy = true; break; }
    }
    ok('TRUST_PROXY=1 时按 XFF 分桶', !bypassUnderProxy);
  } finally {
    proxyChild.kill('SIGTERM');
    await sleep(300);
    cleanupDb(DB_JSON + '.proxy');
    try { if (fs.existsSync(DB + '.proxy')) fs.unlinkSync(DB + '.proxy'); } catch (e) {}
  }

  console.log('\n[15] 部署凭据不内置');
  const syncEnv = Object.assign({}, process.env);
  delete syncEnv.SHARECODE;
  delete syncEnv.ADMIN_PASS;
  const syncChild = spawn(process.execPath, ['tools/ops/sync-live.mjs', '--dry'], {
    cwd: ROOT, env: syncEnv, stdio: ['ignore', 'pipe', 'pipe']
  });
  let syncErr = '';
  syncChild.stderr.on('data', (d) => { syncErr += d.toString(); });
  const syncCode = await new Promise((r) => syncChild.on('close', r));
  ok('sync-live 缺凭据时退出而非用默认值', syncCode === 2 && /SHARECODE|ADMIN_PASS/.test(syncErr), syncErr.slice(0, 120));
} catch (e) {
  fail++;
  console.error('\n✗ 测试异常:', e.message);
  console.error(bootLog.slice(-1500));
} finally {
  child.kill('SIGTERM');
  await sleep(400);
  cleanupDb(ENGINE === 'sqlite' ? DB : DB_JSON);
  cleanupDb(DB_JSON);
  try { if (fs.existsSync(DB_JSON + '.proxy.tmp')) fs.unlinkSync(DB_JSON + '.proxy.tmp'); } catch (e) {}
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
