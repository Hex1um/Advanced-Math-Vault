/**
 * 用 CDP 在真实浏览器里跑一段 JS 并返回结果（调试用）
 * 用法：node tools/cdp-eval.mjs "<url>" "<js expression>" [waitMs]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const url = process.argv[2];
const expr = process.argv[3];
const waitMs = Number(process.argv[4] || 8000);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const profile = 'C:\\Users\\11603\\AppData\\Local\\Temp\\mv-cdp-profile';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=1440,1000', 'about:blank'
], { stdio: 'ignore' });

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

  const out = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(out.result && out.result.result ? out.result.result.value : out, null, 2));

  if (process.env.SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.SHOT, Buffer.from(shot.result.data, 'base64'));
    console.log('screenshot -> ' + process.env.SHOT);
  }
} catch (e) {
  console.error('CDP 出错:', e.message);
  process.exitCode = 1;
} finally {
  try { if (ws) ws.close(); } catch (e) {}
  child.kill();
}
