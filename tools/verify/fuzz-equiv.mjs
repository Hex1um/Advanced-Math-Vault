#!/usr/bin/env node
/**
 * 判题引擎 fuzz / 输入护栏自测（零依赖，纯本地）
 *
 *   node tools/verify/fuzz-equiv.mjs
 *
 * 为什么单独一个脚本：
 *   判题引擎吃的是**用户提交的答案**，属于最典型的不可信输入面。
 *   math-equiv 是递归下降解析 + 递归求值，physics-equiv 是一串全局正则替换，
 *   两者对「几千层括号」「几十万字符」「控制字符」都不能崩、不能卡。
 *
 * 断言分三类：
 *   1. 超长/超深输入必须被**挡在解析之前**（reason 是 too_long / too_deep，不是 parse_*_failed）
 *   2. 任何输入都不能抛异常（抛到 HTTP 层就是 500）
 *   3. 全部用例要在时间预算内跑完（防止正则回溯把事件循环按住）
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const { isMathEquivalent } = require(path.join(ROOT, 'lib', 'math-equiv.js'));
const phys = require(path.join(ROOT, 'lib', 'physics-equiv.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + String(extra).slice(0, 200) : '')); }
}

function noThrow(name, fn) {
  try { fn(); ok(name, true); }
  catch (e) { ok(name, false, (e && e.message) || e); }
}

console.log('[1] 括号嵌套（递归深度）');
const deep = '('.repeat(900) + 'x' + ')'.repeat(900);
noThrow('900 层括号不抛异常', () => isMathEquivalent(deep, 'x'));
ok('900 层括号判定为 too_deep', isMathEquivalent(deep, 'x').reason === 'too_deep', JSON.stringify(isMathEquivalent(deep, 'x')));
const deepMinus = '-'.repeat(400) + 'x';
ok('连续一元负号同样受限', ['too_deep', 'parse_user_failed'].includes(isMathEquivalent(deepMinus, 'x').reason), JSON.stringify(isMathEquivalent(deepMinus, 'x')));
/* 合法深度必须仍然判得出来：护栏不能把正常答案一起拦了 */
ok('20 层括号仍判等价', isMathEquivalent('('.repeat(20) + 'x' + ')'.repeat(20), 'x').ok === true);

console.log('\n[2] 超长输入');
const long = 'x+'.repeat(1200) + '1';            // 2401 字符
noThrow('2401 字符不抛异常', () => isMathEquivalent(long, 'x'));
ok('超长输入判定为 too_long', isMathEquivalent(long, 'x').reason === 'too_long', JSON.stringify(isMathEquivalent(long, 'x')));
ok('标准答案侧超长也挡', isMathEquivalent('x', long).reason === 'too_long');
ok('1999 字符以内不受影响', isMathEquivalent('x'.repeat(1998), 'x').reason !== 'too_long');

console.log('\n[3] 垃圾字符 / 控制字符 / 编码残留');
const junk = [
  'alert(1)', '<script>alert(1)</script>', '\u0000\u0001\u0007x', '\\frac{}{}', '((()))',
  '\\sin', '^^^x', '1e999999', '\\left(\\right', '%%%%', '｜｜｜', '\uD800', 'x'.repeat(60) + '\u0000'
];
for (const s of junk) {
  noThrow('不抛异常: ' + JSON.stringify(s).slice(0, 24), () => isMathEquivalent(s, 'x'));
}
ok('null/undefined 不抛异常', isMathEquivalent(null, undefined).ok === false);

console.log('\n[4] 随机模糊输入（固定种子，失败可复现）');
let seed = 20261127;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
const ALPHA = '()+-*/^x0123456789\\{}|. sinco_';
let worst = 0;
const t0 = Date.now();
for (let i = 0; i < 400; i++) {
  const len = 1 + Math.floor(rnd() * 120);
  let s = '';
  for (let k = 0; k < len; k++) s += ALPHA[Math.floor(rnd() * ALPHA.length)];
  const t = Date.now();
  try { isMathEquivalent(s, 'x'); isMathEquivalent('x', s); }
  catch (e) { ok('随机输入 #' + i + ' 不抛异常', false, (e && e.message) || e); }
  worst = Math.max(worst, Date.now() - t);
}
ok('400 组随机输入全部不抛异常', true);
const cost = Date.now() - t0;
ok('单组最坏耗时 < 50ms（实际 ' + worst + 'ms）', worst < 50, worst + 'ms');
ok('400 组总耗时 < 3s（实际 ' + cost + 'ms）', cost < 3000, cost + 'ms');

console.log('\n[5] 物理判题：长度护栏与脏单位');
const longAns = '1'.repeat(5000) + ' m/s';
noThrow('超长答案不抛异常', () => phys.checkAnswer(longAns, '10 m/s', {}));
const longRes = phys.checkAnswer(longAns, '10 m/s', {});
ok('超长答案降级而不是判错', longRes.deferred === true && longRes.reason === 'too_long', JSON.stringify(longRes).slice(0, 160));
const unitJunk = phys.checkAnswer('3 m//s^^2', '3 m/s^2', {});
ok('脏单位不抛异常且给出可读结论', !!unitJunk && typeof unitJunk.verdict === 'string', JSON.stringify(unitJunk).slice(0, 120));
const deepUnit = 'm/' + '('.repeat(500) + 's' + ')'.repeat(500);
noThrow('深层括号单位不抛异常', () => phys.checkAnswer('1 ' + deepUnit, '1 m/s', {}));
ok('正常答案仍判对（护栏未误伤）', phys.checkAnswer('72 km/h', '20 m/s', {}).ok === true);

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
