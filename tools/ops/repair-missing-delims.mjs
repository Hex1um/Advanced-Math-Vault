#!/usr/bin/env node
/**
 * 修复历史批次里被旧导入脚本吃掉的 $...$ 片段（batch-12 两条二重积分题）。
 *
 * 背景：老版本导入时用字符串 replace 处理公式，把 `$...$` 整段当分隔符吞掉，
 * 导致题干/提示/解答里出现「内层积分  ，故」这种空洞，以及缺了开头的 `$`。
 * 这里按题目定位做**精确替换**，不做任何模糊猜测；替换表之外的字段一律不动。
 *
 * 用法：node tools/ops/repair-missing-delims.mjs [--apply]
 *   默认 dry-run，只报告将要改动的字段。
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('data/batch-12.json');
const APPLY = process.argv.includes('--apply');

const HINT_FIX = {
  '化为区域 \\le y\\le2x,\\ 0\\le x\\le1$ 上的二重积分': '化为区域 $x\\le y\\le2x,\\ 0\\le x\\le1$ 上的二重积分',
  '先对 $ 积分得对数之差': '先对 $y$ 积分得对数之差'
};

const SOLUTION_FIX = {
  // 分式线性二重和极限
  '**步骤1**：令 =\\frac in,y=\\frac jn$，化为 =\\int_0^1\\mathrm{d}x\\int_x^{2x}\\frac{\\mathrm{d}y}{1+x+y}$。\n\n**步骤2**：内层积分 $=\\ln(1+3x)-\\ln(1+2x)$，故 =\\int_0^1\\ln\\frac{1+3x}{1+2x}\\,\\mathrm{d}x$。\n\n**步骤3**：利用 $\\int_0^1\\ln(1+ax)\\,\\mathrm{d}x=\\frac{(1+a)\\ln(1+a)-a}{a}$，得 =\\frac{4\\ln4-3}{3}-\\frac{3\\ln3-2}{2}=\\frac83\\ln2-\\frac32\\ln3$。':
    '**步骤1**：令 $x=\\frac in,y=\\frac jn$，区域为 $x\\le y\\le2x,\\ 0\\le x\\le1$，化为 $I=\\int_0^1\\mathrm{d}x\\int_x^{2x}\\frac{\\mathrm{d}y}{1+x+y}$。\n\n**步骤2**：内层积分 $=\\ln(1+3x)-\\ln(1+2x)$，故 $I=\\int_0^1\\ln\\frac{1+3x}{1+2x}\\,\\mathrm{d}x$。\n\n**步骤3**：利用 $\\int_0^1\\ln(1+ax)\\,\\mathrm{d}x=\\frac{(1+a)\\ln(1+a)-a}{a}$，得 $I=\\frac{4\\ln4-3}{3}-\\frac{3\\ln3-2}{2}=\\frac83\\ln2-\\frac32\\ln3$。',
  // 指数正弦混合和极限
  '**步骤1**：化为 =\\int_0^1\\mathrm{d}x\\int_x^1 e^{-x}\\sin y\\,\\mathrm{d}y=\\int_0^1 e^{-x}(\\cos x-\\cos1)\\,\\mathrm{d}x$。\n\n**步骤2**：$\\int_0^1 e^{-x}\\cos x\\,\\mathrm{d}x=\\left[\\frac{e^{-x}(\\sin x-\\cos x)}{2}\\right]_0^1=\\frac{\\sin1-\\cos1}{2e}+\\frac12$，且 $\\int_0^1e^{-x}\\,\\mathrm{d}x=1-\\frac1e$。\n\n**步骤3**：=\\frac12+\\frac{\\sin1-\\cos1}{2e}-\\cos1\\left(1-\\frac1e\\right)=\\frac12-\\cos1+\\frac{\\sin1+\\cos1}{2e}$。':
    '**步骤1**：化为 $I=\\int_0^1\\mathrm{d}x\\int_x^1 e^{-x}\\sin y\\,\\mathrm{d}y=\\int_0^1 e^{-x}(\\cos x-\\cos1)\\,\\mathrm{d}x$。\n\n**步骤2**：$\\int_0^1 e^{-x}\\cos x\\,\\mathrm{d}x=\\left[\\frac{e^{-x}(\\sin x-\\cos x)}{2}\\right]_0^1=\\frac{\\sin1-\\cos1}{2e}+\\frac12$，且 $\\int_0^1e^{-x}\\,\\mathrm{d}x=1-\\frac1e$。\n\n**步骤3**：$I=\\frac12+\\frac{\\sin1-\\cos1}{2e}-\\cos1\\left(1-\\frac1e\\right)=\\frac12-\\cos1+\\frac{\\sin1+\\cos1}{2e}$。'
};

const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
let changed = 0;

for (const p of list) {
  if (!Array.isArray(p.hints)) p.hints = [];
  p.hints = p.hints.map((h) => {
    if (HINT_FIX[h]) { changed++; console.log(`[hint] ${p.title} -> 已修复`); return HINT_FIX[h]; }
    return h;
  });
  if (SOLUTION_FIX[p.solution]) {
    p.solution = SOLUTION_FIX[p.solution];
    changed++;
    console.log(`[solution] ${p.title} -> 已修复`);
  }
}

console.log(`\n共 ${changed} 处替换。`);
if (!APPLY) {
  console.log('[DRY-RUN] 未写入。确认后加 --apply。');
} else if (changed) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2) + '\n', 'utf8');
  console.log('[APPLIED] 已写回 ' + FILE);
}
