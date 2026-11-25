#!/usr/bin/env node
/**
 * lib/http.js + lib/ratelimit.js 单测：安全边界的纯函数部分
 *
 *   node tools/verify/http-test.mjs
 *
 * 覆盖：
 *   - resolveInside 不放过 public_backup/ 这类「同前缀兄弟目录」
 *   - isHttps / clientIp 在 TRUST_PROXY 关闭时忽略伪造头
 *   - 500 脱敏：不回传异常详情与绝对路径，只给 reqId
 *   - 限流桶有容量上限（不会被打成 OOM）
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const H = require(path.join(ROOT, 'lib', 'http.js'));
const { createRateLimiter } = require(path.join(ROOT, 'lib', 'ratelimit.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const PUBLIC = path.join(ROOT, 'public');

console.log('\n[1] 静态路径解析');
ok('正常文件解析到 public 内', H.resolveInside(PUBLIC, '/index.html') === path.join(PUBLIC, 'index.html'));
ok('阻断 ../ 穿越', H.resolveInside(PUBLIC, '/../server.js') === null);
ok('阻断编码后的 ../ 穿越', H.resolveInside(PUBLIC, '/js/../../server.js') === null);
ok('阻断同前缀兄弟目录', H.resolveInside(PUBLIC, '/../public_backup/a.js') === null);
ok('阻断绝对路径越界', H.resolveInside(PUBLIC, '/..\\..\\etc\\passwd') === null);
ok('根路径映射到 public 本身', H.resolveInside(PUBLIC, '/') === path.resolve(PUBLIC));

console.log('\n[2] TRUST_PROXY 开关');
const reqNoProxy = { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '9.9.9.9' } };
ok('关闭时不认 X-Forwarded-Proto', H.isHttps(reqNoProxy, { trustProxy: false }) === false);
ok('关闭时不认 X-Forwarded-For', H.clientIp(reqNoProxy, { trustProxy: false }) === '9.9.9.9');
ok('开启时认 X-Forwarded-Proto', H.isHttps(reqNoProxy, { trustProxy: true }) === true);
ok('开启时认 X-Forwarded-For', H.clientIp(reqNoProxy, { trustProxy: true }) === '1.2.3.4');
const reqMulti = { headers: { 'x-forwarded-proto': 'https, http', 'x-forwarded-for': '5.6.7.8, 10.0.0.1' }, socket: {} };
ok('多级代理取首段协议', H.isHttps(reqMulti, { trustProxy: true }) === true);
ok('多级代理取首个 IP', H.clientIp(reqMulti, { trustProxy: true }) === '5.6.7.8');
ok('socket.encrypted 仍可判定 https', H.isHttps({ headers: {}, socket: { encrypted: true } }, { trustProxy: false }) === true);

console.log('\n[3] 500 脱敏');
const boom = new Error('ENOENT: no such file or directory, open \'C:\\secret\\data\\vault.db\'');
const prod = H.sanitizeError(boom, {});
const body = JSON.stringify(prod);
ok('不泄露异常原文', !/secret|ENOENT|vault\.db/.test(body), body);
ok('不回传堆栈', !/at \w+/.test(body), body);
ok('给出统一文案', prod.error === '服务器内部错误', body);
ok('带 8 位 reqId', /^[0-9a-f]{8}$/.test(prod.reqId), prod.reqId);
const dev = H.sanitizeError(boom, { dev: true });
ok('开发模式附 detail', /ENOENT/.test(String(dev.detail)), JSON.stringify(dev));

console.log('\n[4] 限流器');
const rl = createRateLimiter({ maxBuckets: 16 });
let blocked = -1;
for (let i = 1; i <= 6; i++) { if (!rl.hit('k1', 3, 60000)) { blocked = i; break; } }
ok('超过上限即拦截', blocked === 4, 'blocked at ' + blocked);
ok('不同 key 独立计数', rl.hit('k2', 3, 60000) === true);
for (let i = 0; i < 200; i++) rl.hit('spray-' + i, 5, 60000);
ok('桶数不超过上限', rl.stats().buckets <= 16, JSON.stringify(rl.stats()));

console.log('\n[5] CORS 组合合法性');
function fakeRes() {
  const h = {};
  return { h, headersSent: false, setHeader: (k, v) => { h[k] = v; } };
}
const r1 = fakeRes();
H.applyCors({ headers: { origin: 'https://evil.example' } }, r1, ['*']);
ok('通配符来源不叠加 Allow-Credentials', r1.h['Access-Control-Allow-Origin'] === '*' && !r1.h['Access-Control-Allow-Credentials']);
const r2 = fakeRes();
H.applyCors({ headers: { origin: 'https://ok.example' } }, r2, ['https://ok.example']);
ok('命中白名单才允许带凭据', r2.h['Access-Control-Allow-Origin'] === 'https://ok.example' && r2.h['Access-Control-Allow-Credentials'] === 'true');
const r3 = fakeRes();
H.applyCors({ headers: { origin: 'https://evil.example' } }, r3, ['https://ok.example']);
ok('非白名单来源不下发 ACAO', !r3.h['Access-Control-Allow-Origin']);

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
