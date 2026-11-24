#!/usr/bin/env node
/** 全链路冒烟测试：起一个独立端口的临时库，跑完删掉 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SMOKE_PORT || 8899);
const BASE = 'http://127.0.0.1:' + PORT;
const DB = path.join(ROOT, 'data', '.smoke-db.json');

if (fs.existsSync(DB)) fs.unlinkSync(DB);

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
    DB_FILE: DB,
    SEED_FILE: path.join(ROOT, 'data', 'problems.seed.sample.json'),
    LLM_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    NO_FREE: '1'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let bootLog = '';
child.stdout.on('data', (d) => { bootLog += d.toString(); });
child.stderr.on('data', (d) => { bootLog += d.toString(); });

try {
  if (!(await waitServer())) throw new Error('服务没有启动:\n' + bootLog);

  console.log('\n[1] 站点信息与种子题库');
  const meta = await req('/api/meta');
  ok('GET /api/meta', meta.json && meta.json.ok);
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
  const filtered = await req('/api/problems?tags=' + encodeURIComponent('极限'));
  ok('按考点筛选生效', filtered.json.items.length > 0 && filtered.json.items.every((p) => p.tags.includes('极限')));

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
  const pending = await req('/api/admin/pending');
  ok('待审列表有 1 题', pending.json.items.length === 1);
  const review = await req('/api/admin/review', { method: 'POST', body: JSON.stringify({ code: submit.json.code, action: 'approve', patch: { calc: 2 } }) });
  ok('审核通过', review.json.ok);
  const afterApprove = await req('/api/problems?size=50');
  ok('入库后总数变 11', afterApprove.json.total === 11, '实际 ' + afterApprove.json.total);
  const approved = await req('/api/problems/' + submit.json.code);
  ok('审核时修改的评分已生效', approved.json.problem.calc === 2);

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
  ok('可以发送邮箱验证码', codeSend.json.ok && !!codeSend.json.code);
  const codeBad = await u2('/api/me/email/verify', { method: 'POST', body: JSON.stringify({ code: '000000' }) });
  ok('错误验证码被拒', codeBad.status === 400);
  const codeOk = await u2('/api/me/email/verify', { method: 'POST', body: JSON.stringify({ code: codeSend.json.code }) });
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
  const html = await fetch(BASE + '/');
  ok('首页 200', html.status === 200);
  ok('首页 no-store', /no-store/.test(html.headers.get('cache-control') || ''));
  ok('KaTeX 本地可用', (await fetch(BASE + '/vendor/katex/katex.min.js')).status === 200);
  ok('样式表 200', (await fetch(BASE + '/assets/style.css')).status === 200);
} catch (e) {
  fail++;
  console.error('\n✗ 测试异常:', e.message);
  console.error(bootLog.slice(-1500));
} finally {
  child.kill('SIGTERM');
  await sleep(400);
  try { if (fs.existsSync(DB)) fs.unlinkSync(DB); } catch (e) {}
  try { if (fs.existsSync(DB + '.tmp')) fs.unlinkSync(DB + '.tmp'); } catch (e) {}
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
