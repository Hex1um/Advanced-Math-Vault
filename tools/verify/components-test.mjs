#!/usr/bin/env node
/**
 * 前端公共组件单测（HTML 字符串层面的契约）
 *
 *   node tools/verify/components-test.mjs
 *
 * 组件是「纯函数 → HTML 字符串」，所以不需要 DOM，只要给 window 挂上
 * Md / UI 的最小桩即可在 Node 里断言。重点是：转义、必填结构、可选参数不炸。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

/* 最小桩：只实现组件调用到的接口 */
globalThis.window = {
  Md: {
    esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    // 真实 md.js 的 inlineTex 会先 esc 再渲染，桩也照做，否则转义断言测不到
    inlineTex: (s) => 'TEX(' + String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + ')'
  },
  UI: {
    levelOf: () => ({ color: '#f00' }),
    tagBadges: () => '<span class="badges"></span>',
    scoreBars: () => '<div class="bars"></div>',
    levelBadge: () => '<span class="lvl">中等</span>'
  }
};

const C = require(path.join(ROOT, 'public', 'js', 'components.js'));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('\n[1] 标签 chips');
const chips = C.tagChips(['定积分', '换元']);
ok('渲染两个标签', (chips.match(/class="tag"/g) || []).length === 2, chips);
ok('转义 HTML', C.tagChips(['<img src=x>']).indexOf('&lt;img') > 0);
ok('支持带计数的对象', /<span class="n">12<\/span>/.test(C.tagChips([{ name: '极限', count: 12 }])));
ok('空数组返回空串', C.tagChips([]) === '' && C.tagChips(null) === '');

console.log('\n[2] 统计条');
const strip = C.statStrip([{ k: '错题数', v: 12, unit: '题' }, { k: '到期', v: 0, unit: '题' }]);
ok('列数与条目一致', /repeat\(2,1fr\)/.test(strip), strip);
ok('带单位', /12<small>题<\/small>/.test(strip));
ok('null 显示破折号', /—/.test(C.statStrip([{ k: 'x', v: null }])));

console.log('\n[3] 自评按钮');
const bar = C.ratingBar('HS1001');
ok('四个评分', (bar.match(/data-rate=/g) || []).length === 4, bar);
ok('带题号', /data-code="HS1001"/.test(bar));
ok('包含中文标签', /忘了/.test(bar) && /简单/.test(bar));

console.log('\n[4] 题目行');
const p = { code: 'HS1001', title: '题', excerpt: '求 $\\int x$', tags: ['定积分'], difficulty: 6, solved: false, solvedCount: 3, attemptCount: 7 };
const row = C.problemRow(p, { paperAdded: true });
ok('包含题号与链接', /HS1001/.test(row) && /href="#\/problem\/HS1001"/.test(row));
ok('走 inlineTex 渲染摘要', /TEX\(求 \$\\int x\$\)/.test(row));
ok('包含通过率', /通过率/.test(row));
ok('加入试卷按钮已选状态', /✓/.test(row) && /paper-add/.test(row));
ok('可隐藏加入试卷按钮', !/paper-add/.test(C.problemRow(p, { showPaperAdd: false })));
ok('可自定义链接', /href="#\/problem\/HS1001\?review=1"/.test(C.problemRow(p, { href: '#/problem/HS1001?review=1' })));
ok('摘要里的 HTML 会被转义', C.problemRow({ code: 'X1', excerpt: '<script>alert(1)</script>', tags: [] }).indexOf('<script>') < 0);

console.log('\n[5] 空状态');
const empty = C.emptyState('没有结果', '换个条件试试', '<a class="btn" href="#/problems">回题库</a>');
ok('标题与说明', /没有结果/.test(empty) && /换个条件试试/.test(empty));
ok('可选操作按钮', /回题库/.test(empty));
ok('标题转义', C.emptyState('<b>x</b>', '').indexOf('&lt;b&gt;') > 0);

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
