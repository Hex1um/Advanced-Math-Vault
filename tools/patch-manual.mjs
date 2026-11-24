#!/usr/bin/env node
/**
 * 个别题目的手工修补（自动规则覆盖不到的破损公式）。
 * 只处理 tools/fix-latex.mjs 报出来的、KaTeX 校验仍失败的几条。
 *   node tools/patch-manual.mjs [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const APPLY = process.argv.includes('--apply');
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const patched = [];

function find(code) { return db.problems.find((p) => p.code === code); }

/* HS2152：原文 `$\Phi(z)=\int...$` 定界符错配（开头 $$ 结尾单 $），重写整段 */
{
  const p = find('HS2152');
  if (p) {
    p.statement = p.statement.replace(/附表：[\s\S]*?(?=\n\n\|)/,
      '附表：标准正态分布表 $\\Phi(z)=\\int_{-\\infty}^{z}\\frac{1}{\\sqrt{2\\pi}}\\mathrm{e}^{-\\frac{t^2}{2}}\\,\\mathrm{d}t$');
    patched.push(p.code);
  }
}

/* HS3302：脚注写法是「此处有误，应改为 x³/6+1/3」，直接按更正后的式子写 */
{
  const p = find('HS3302');
  if (p) {
    const head = p.statement.slice(0, p.statement.indexOf('面积和为'));
    p.statement = head + '面积和为$\\frac{x^{3}}{6}+\\frac{1}{3}$. '
      + '求$y=y(x)$与$y$轴及$x$轴所围成的平面图形绕$y$轴旋转一周所得的旋转体的体积.'
      .replace('$y$轴', '$y$ 轴');
    p.statement = p.statement.replace('$O\nCMA$', '$OCMA$');
    p.repairNote = '原题脚注指出印刷式子有误，已按脚注更正为 x³/6+1/3';
    patched.push(p.code);
  }
}

/* 整卷被并成一道题的，转待审（等人工拆分），不在前台露出 */
for (const code of ['HS2672', 'HS2688']) {
  const p = find(code);
  if (p && p.status === 'approved') {
    p.status = 'pending';
    p.repairNote = '题干含多道小题（整卷被合并），待人工拆分';
    patched.push(p.code + '(转待审)');
  }
}

console.log('待修补:', patched.join(', ') || '无');
if (APPLY) {
  const bak = DB_FILE + '.before-manual-' + Date.now() + '.json';
  fs.copyFileSync(DB_FILE, bak);
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  console.log('已写盘 | 备份', path.basename(bak));
}
for (const code of ['HS2152', 'HS3302']) {
  const p = find(code);
  if (p && APPLY) console.log('---', code, '\n' + p.statement.slice(0, 200));
}
