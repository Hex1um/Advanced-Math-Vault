#!/usr/bin/env node
/**
 * md.js 单测：XSS 链接白名单、行内代码与公式的边界、inlineTex 不被 Markdown 破坏
 *
 *   node tools/verify/md-test.mjs
 *
 * md.js 是浏览器脚本，但只在 IIFE 里挂 window.Md，同时带一个 module.exports 兜底，
 * 所以这里能直接 require 进来跑纯函数断言（不依赖 DOM / KaTeX）。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const Md = require(path.join(ROOT, 'public', 'js', 'md.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function html(src) { return Md.toHtml(src); }
function hasExecutableHref(h) { return /href\s*=\s*["']?\s*(javascript|vbscript|data:text\/html)/i.test(h); }

console.log('\n[1] URL 白名单：可执行协议一律拦掉');
const evil = [
  '[x](javascript:alert(1))',
  '[x](JAVASCRIPT:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x](java\tscript:alert(1))',
  '[x](java&#09;script:alert(1))',
  '[x](vbscript:msgbox(1))',
  '[x](data:text/html;base64,PHNjcmlwdD4=)',
  '[x](file:///etc/passwd)',
  '<javascript:alert(1)>'
];
for (const src of evil) {
  ok('拦截 ' + src, !hasExecutableHref(html(src)), html(src).slice(0, 120));
}

console.log('\n[2] URL 白名单：正常链接仍然可用');
const good = html('[官网](https://example.com/a?b=1&c=2)');
ok('https 链接保留', /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2"/.test(good), good);
ok('外链带 rel 与 target', /target="_blank"/.test(good) && /rel="noopener noreferrer nofollow"/.test(good), good);
const mail = html('[写信](mailto:a@b.com)');
ok('mailto 保留且不加 target', /href="mailto:a@b\.com"/.test(mail) && !/target="_blank"/.test(mail), mail);
const rel = html('[题库](#/problems)');
ok('锚点链接保留', /href="#\/problems"/.test(rel), rel);
const img = html('![图](data:image/png;base64,iVBORw0KGgo=)');
ok('data:image 图片放行', /<img src="data:image\/png;base64,/.test(img), img);
const badImg = html('![图](data:text/html;base64,PHNjcmlwdD4=)');
ok('data:text/html 图片降级为文本', !/<img/.test(badImg) && !hasExecutableHref(badImg), badImg);

console.log('\n[3] 行内代码里的 $ 不当公式');
const code = html('`$a+b$` 是公式写法');
ok('行内代码保留为 <code>', /<code>\$a\+b\$<\/code>/.test(code), code);
ok('行内代码内不产生 math-block', !/math-block/.test(code), code);
const fence = html('```js\nconst x = "$a$";\n```');
ok('围栏代码块保留', /<pre><code class="language-js">const x = &quot;\$a\$&quot;;<\/code><\/pre>/.test(fence), fence);

console.log('\n[4] inlineTex 不被 Markdown 破坏');
const t1 = Md.inlineTex('$a_1 * b_2 * c_3$');
ok('$a_1 * b_2 * c_3$ 不产出 <em>', !/<em>/.test(t1) && t1.indexOf('a_1 * b_2 * c_3') >= 0, t1);
const t2 = Md.inlineTex('求 $\\frac{1}{2}$ 的值');
ok('行内公式整体保留', /\$\\frac\{1\}\{2\}\$/.test(t2), t2);
const t3 = Md.inlineTex('**加粗** 与 $x$');
ok('普通加粗仍然生效', /<strong>加粗<\/strong>/.test(t3), t3);

console.log('\n[5] 块级公式与占位符');
const block = html('$$\n\\int_0^1 x\\,dx\n$$');
ok('$$ 独占行输出 math-block', /<div class="math-block">\$\$/.test(block), block);
const bracket = html('\\[a+b\\]');
ok('\\[...\\] 识别为块级公式', /\$\$a\+b\$\$/.test(bracket), bracket);
const paren = html('行内 \\(a+b\\) 结束');
ok('\\(...\\) 识别为行内公式', /\$a\+b\$/.test(paren), paren);
const nullChar = html('原文含 \u0000 空字符 [x](https://a.b)');
ok('原文含 \\u0000 不破坏渲染', /<a href="https:\/\/a\.b"/.test(nullChar), nullChar);

console.log('\n[6] 反斜杠转义的 $');
const escaped = html('价格 \\$5 和 $x$');
ok('\\$ 不开启公式', escaped.indexOf('\\$5') >= 0 && escaped.indexOf('$x$') >= 0, escaped);

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
