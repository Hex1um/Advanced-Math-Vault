#!/usr/bin/env node
/**
 * 运维应急通道自测：一次性重置管理员密码
 *
 *   node tools/verify/ops-reset-test.mjs
 *
 * 流程：起服务 → 注册首个账号（管理员）→ 停服 → 放 reset-admin.json → 再起服
 *      → 旧密码失效、新密码可用、文件已删除、旧会话被清掉。
 * 另外验证「缺少 token / 密码太短 / 用户不存在」时不改库。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-ops-'));
const DB = path.join(TMP, 'db.json');
const OPS = path.join(TMP, 'ops');
const PORT = 8913;
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
let log = '';

function start() {
  log = '';
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DB_FILE: DB, OPS_DIR: OPS,
      SEED_FILE: path.join(ROOT, 'data', 'problems.seed.sample.json'),
      LLM_API_KEY: '', DEEPSEEK_API_KEY: '', NO_FREE: '1',
      NODE_ENV: 'development', MV_NO_DOTENV: '1', NO_AUTO_RESTORE: '1'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
}

async function ready() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/meta')).ok) return true; } catch (e) {}
    await sleep(200);
  }
  return false;
}

async function stop() {
  if (!child) return;
  child.kill('SIGTERM');
  await sleep(500);
  child = null;
}

async function login(name, password) {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password })
  });
  let j = null;
  try { j = await res.json(); } catch (e) {}
  const raw = (res.headers.getSetCookie ? res.headers.getSetCookie()[0] : res.headers.get('set-cookie')) || '';
  return { status: res.status, json: j, cookie: String(raw).split(';')[0] };
}

try {
  fs.mkdirSync(OPS, { recursive: true });

  console.log('\n[1] 首次启动并注册管理员');
  start();
  ok('服务启动', await ready());
  const reg = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'opsreset', password: 'OldPass123' })
  });
  const regJson = await reg.json();
  ok('注册成功且成为管理员', regJson.ok && regJson.user && regJson.user.role === 'admin', JSON.stringify(regJson).slice(0, 120));
  const before = await login('opsreset', 'OldPass123');
  ok('旧密码可登录', before.status === 200 && before.json.ok);
  const oldCookie = before.cookie;
  await sleep(700);   // 等 400ms 防抖写盘：Windows 上 SIGTERM 不会触发 handler
  await stop();

  console.log('\n[2] 三种无效请求都不改库');
  fs.writeFileSync(path.join(OPS, 'reset-admin.json'), JSON.stringify({ name: 'opsreset', password: 'NewPass456' }), 'utf8');
  start();
  await ready();
  const noToken = await login('opsreset', 'OldPass123');
  ok('缺 token 时不重置（旧密码仍可用）', noToken.status === 200 && noToken.json.ok);
  ok('无效文件被改名保留', fs.existsSync(path.join(OPS, 'reset-admin.json.failed')));
  await sleep(700);   // 等 400ms 防抖写盘：Windows 上 SIGTERM 不会触发 handler
  await stop();

  fs.writeFileSync(path.join(OPS, 'reset-admin.json'), JSON.stringify({ name: 'nobody', password: 'NewPass456', token: '0123456789abcdef' }), 'utf8');
  start();
  await ready();
  ok('用户不存在时不重置', (await login('opsreset', 'OldPass123')).json.ok);
  await sleep(700);   // 等 400ms 防抖写盘：Windows 上 SIGTERM 不会触发 handler
  await stop();

  console.log('\n[3] 合法请求：重置并清理会话');
  fs.writeFileSync(path.join(OPS, 'reset-admin.json'), JSON.stringify({ name: 'opsreset', password: 'NewPass456', token: '0123456789abcdef' }), 'utf8');
  start();
  await ready();
  ok('启动日志有重置记录', /已重置 opsreset 的密码/.test(log), log.slice(-200));
  ok('一次性文件已删除', !fs.existsSync(path.join(OPS, 'reset-admin.json')));
  const oldPw = await login('opsreset', 'OldPass123');
  ok('旧密码失效', oldPw.status === 401, 'status ' + oldPw.status);
  const newPw = await login('opsreset', 'NewPass456');
  ok('新密码可登录', newPw.status === 200 && newPw.json.ok);
  // /api/me 对未登录请求也返回 200，只是 user 为 null，所以看字段而不是状态码
  const me = await fetch(BASE + '/api/me', { headers: { cookie: oldCookie } });
  const meJson0 = await me.json();
  ok('重置前的旧会话已失效', !meJson0.user, JSON.stringify(meJson0).slice(0, 100));
  const me2 = await fetch(BASE + '/api/me', { headers: { cookie: newPw.cookie } });
  const meJson = await me2.json();
  ok('新会话是管理员', me2.status === 200 && meJson.user && meJson.user.role === 'admin');
} catch (e) {
  fail++;
  console.error('\n✗ 测试异常:', e.message);
  console.error(log.slice(-800));
} finally {
  await sleep(700);   // 等 400ms 防抖写盘：Windows 上 SIGTERM 不会触发 handler
  await stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
