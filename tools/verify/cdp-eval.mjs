/**
 * 用 CDP 在真实浏览器里跑一段 JS 并返回结果（调试用）
 * 用法：node tools/verify/cdp-eval.mjs "<url>" "<js expression>" [waitMs]
 *      node tools/verify/cdp-eval.mjs --shot <url> <out.png>   # 顺便截图
 *
 * 浏览器按顺序探测（Edge / Chrome，环境变量 MV_BROWSER 可强制指定）。
 * 以前这里写死了某台机器的用户目录，换机器直接「拿不到调试目标」，
 * 所以 profile 目录一律走 os.tmpdir()，并且带上 --no-sandbox 兜底。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const shotMode = args[0] === '--shot';
const url = shotMode ? args[1] : args[0];
const expr = shotMode ? '' : args[1];
const shotFile = shotMode ? args[2] : '';
const waitMs = Number(shotMode ? args[3] : args[2]) || 8000;
const PORT = Number(process.env.MV_CDP_PORT || 9333);
const profile = path.join(os.tmpdir(), 'mv-cdp-profile');

const CANDIDATES = [
  process.env.MV_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);

const BROWSER = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
if (!BROWSER) {
  console.error('找不到可用的 Chromium 内核浏览器；请用 MV_BROWSER=<路径> 指定。');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 从 WorkBuddy/终端继承来的代理变量会让 Chrome 把 127.0.0.1 也走代理，
   本地联调会表现为「页面白屏、evaluate 返回 undefined」。一律清掉再启动。 */
const cleanEnv = Object.assign({}, process.env);
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy']) delete cleanEnv[k];

const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=1440,1000', 'about:blank'
], { stdio: 'ignore', env: cleanEnv });

let ws = null;
try {
  let target = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch (e) {}
  }
  if (!target) throw new Error('拿不到调试目标');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const send = (method, params) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  if (process.env.W) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: Number(process.env.W),
      height: Number(process.env.H || 900),
      deviceScaleFactor: Number(process.env.DPR || 2),
      mobile: true
    });
  }
  await send('Page.navigate', { url });
  await sleep(waitMs);

  if (process.env.LOGIN) {
    const [name, password] = process.env.LOGIN.split(':');
    await send('Runtime.evaluate', {
      expression: `fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:${JSON.stringify(name)},password:${JSON.stringify(password)}})}).then(r=>r.json())`,
      awaitPromise: true, returnByValue: true
    });
    await send('Page.reload', { ignoreCache: true });
    await sleep(Math.min(waitMs, 5000));
  }

  const out = await send('Runtime.evaluate', { expression: shotMode ? 'document.title' : expr, awaitPromise: true, returnByValue: true });
  if (!shotMode) console.log(JSON.stringify(out.result && out.result.result ? out.result.result.value : out, null, 2));

  const wantShot = shotFile || process.env.SHOT;
  if (wantShot) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(wantShot, Buffer.from(shot.result.data, 'base64'));
    console.log('screenshot -> ' + wantShot);
  }
} catch (e) {
  console.error('CDP 出错:', e.message);
  process.exitCode = 1;
} finally {
  try { if (ws) ws.close(); } catch (e) {}
  child.kill();
}
