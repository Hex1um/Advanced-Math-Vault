#!/usr/bin/env node
/**
 * mathkey.js 单测：光标所在公式环境的状态机
 *
 *   node tools/verify/mathkey-test.mjs
 *
 * 用 `|` 标记光标位置，断言 { inMath, mode }。
 * 覆盖旧实现会判错的场景：$$...$$、\[...\]、\(...\)、行内/围栏代码、\$ 转义。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const MK = require(path.join(ROOT, 'public', 'js', 'mathkey.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function ctx(marked) {
  const pos = marked.indexOf('|');
  if (pos < 0) throw new Error('用例缺少光标标记 |');
  return MK.context(marked.slice(0, pos) + marked.slice(pos + 1), pos);
}

function expect(name, marked, want) {
  const c = ctx(marked);
  ok(name, c.mode === want && c.inMath === (want !== 'TEXT' && !/CODE/.test(want)), JSON.stringify(c));
}

console.log('\n[1] 块级与行内公式');
expect('$$ 未闭合 → DOLLAR_BLOCK', '$$a+b|', 'DOLLAR_BLOCK');
expect('$$ 已闭合 → TEXT', '$$a+b$$|', 'TEXT');
expect('$$ 中段 → DOLLAR_BLOCK', '$$a|+b$$', 'DOLLAR_BLOCK');
expect('\\[ 未闭合 → BRACKET_BLOCK', '\\[a|\\]', 'BRACKET_BLOCK');
expect('\\[ 已闭合 → TEXT', '\\[a\\]|', 'TEXT');
expect('\\( 未闭合 → PAREN_INLINE', '\\(a|)', 'PAREN_INLINE');
expect('\\( 已闭合 → TEXT', '\\(a\\)|', 'TEXT');
expect('单 $ → DOLLAR_INLINE', '$a|b$', 'DOLLAR_INLINE');
expect('单 $ 已闭合 → TEXT', '$a$|', 'TEXT');

console.log('\n[2] 代码里的分隔符不算公式');
expect('行内代码中的 $ 不算公式', '`$x$|`', 'INLINE_CODE');
expect('行内代码中光标在 $ 之间', '`$x|`', 'INLINE_CODE');
expect('围栏代码中的 $ 不算公式', '```\n$a$|\n```', 'FENCE_CODE');
expect('围栏代码结束后回到 TEXT', '```\ncode\n```|', 'TEXT');
expect('行内代码里的 $$ 也不算', '`$$a$|$`', 'INLINE_CODE');

console.log('\n[3] 转义');
expect('\\$5 不开启公式', '价格 \\$5 |', 'TEXT');
expect('\\$ 后仍能进入公式', '\\$5 和 $x|$', 'DOLLAR_INLINE');
expect('公式里的 \\$ 不闭合', '$a\\$b|$', 'DOLLAR_INLINE');
expect('\\\\ 是反斜杠字面量', '文字 \\\\ |', 'TEXT');

console.log('\n[4] 混合段落');
expect('先代码后公式', '`$a$` 然后 $x|+1$', 'DOLLAR_INLINE');
expect('先公式后代码', '$a$ 然后 `x|`', 'INLINE_CODE');
expect('两段公式之间是 TEXT', '$a$ and | and $b$', 'TEXT');
expect('$$ 之间插行内 $', '$$a$$\n文字 $b|$', 'DOLLAR_INLINE');

console.log('\n[5] 兼容旧接口');
ok('insideMath 等价于 context().inMath', MK.insideMath('$a|b$'.replace('|', ''), 2) === true);
ok('TEXT 环境下 insideMath 为 false', MK.insideMath('abc', 2) === false);

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
