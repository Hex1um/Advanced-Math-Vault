#!/usr/bin/env node
/**
 * 数学等价判题引擎自测。
 *
 * 覆盖两类误判风险：
 *   1. 真等价但不该用字符串比的（半角公式、对数合并、不定积分差常数）；
 *   2. 长得像但不等价的（差一个因子、把极限值当恒等式）—— 这一类必须判 false，
 *      否则判题会开始「放水」。
 */
import { isMathEquivalent, normalizeLatex } from '../../lib/math-equiv.js';

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + JSON.stringify(extra) : '')); }
}

function eq(a, b, opts) {
  const r = isMathEquivalent(a, b, opts);
  ok(`${a}  ≡  ${b}`, r.ok, r);
  return r;
}

function ne(a, b, opts) {
  const r = isMathEquivalent(a, b, opts);
  ok(`${a}  ≢  ${b}`, !r.ok, r);
  return r;
}

console.log('[normalizeLatex]');
ok('去掉 $$ 与 +C', normalizeLatex('$$\\sin x\\cos x + C$$') === 'sin x*cos x' || normalizeLatex('$$\\sin x\\cos x + C$$').indexOf('+ C') < 0, normalizeLatex('$$\\sin x\\cos x + C$$'));
ok('\\frac 展开', normalizeLatex('\\frac{1}{2}\\sin 2x').includes('(1)/(2)'), normalizeLatex('\\frac{1}{2}\\sin 2x'));

console.log('\n[等价]');
eq('\\sin x\\cos x', '\\frac{1}{2}\\sin 2x');
eq('2x', 'x+x');
eq('\\frac{1}{1+x}', '(1+x)^{-1}');
eq('x^2+2x+1', '(x+1)^2');
eq('\\ln|\\sec x+\\tan x|', '\\ln|\\tan(\\frac{x}{2}+\\frac{\\pi}{4})|', { allowConstantOffset: true });
eq('\\frac{1}{2}\\ln(1+x^2)', '\\ln\\sqrt{1+x^2}');
eq('e^{x}\\cdot e^{-x}', '1');

console.log('\n[不等价]');
ne('x^2', 'x^3');
ne('\\sin x', '\\cos x');
ne('\\frac{1-e^{-x}}{x}', '1');           // 极限值不是恒等式
ne('\\ln x', '\\ln 2x');                  // 差常数，但未声明 allowConstantOffset
ne('\\tan x', '\\sin x');
ne('\\arctan x+\\arctan\\frac{1}{x}', '\\frac{\\pi}{2}', { allowConstantOffset: true });  // 只在 x>0 成立，全域不能算恒等
ne('2^{x}', 'x^{2}');

console.log('\n[容错]');
ok('空串/乱码不抛异常', isMathEquivalent('', 'x').ok === false);
ok('非法字符返回解析失败', isMathEquivalent('alert(1)', 'x').reason === 'parse_user_failed' || isMathEquivalent('alert(1)', 'x').ok === false);
ok('未知变量不误判', isMathEquivalent('y^2', 'x^2').ok === false);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
