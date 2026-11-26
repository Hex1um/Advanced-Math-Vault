#!/usr/bin/env node
/**
 * 公式定界符/环境闭合门禁
 *
 * 用法：node tools/verify/check-unclosed-delims.mjs [--strict] [--fix]
 *   --strict  发现任何异常即 exit 1（CI 用）
 *   --fix     就地修复「多余/缺失」的成对分隔符最明显的一类：单个未闭合的 $$
 *             会把结尾补上；其余问题只报告，不猜。
 *
 * 检查项：
 *   1. $$ 成对（忽略转义 \$）
 *   2. 去掉 $$ 后行内 $ 成对
 *   3. \left / \right 数量一致
 *   4. \begin{env} ... \end{env} 栈平衡
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const FIELDS = ['title', 'statement', 'answer', 'solution'];

/* 豁免清单：batch-hust.json 是「整份试卷 LaTeX 源码」的参考转储（answer 字段里
   连着 \begin{document}、minipage 等文档级环境），从未导入题库（库内 0 条），
   因此不参与逐题门禁；单独计数并在报告里列出，避免直接掩盖。 */
const EXEMPT = {
  'batch-hust.json': '整份试卷 LaTeX 源码转储，未导入题库'
};

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* 与后端共用同一份实现：服务端 AI 出题门禁和 CI 门禁不允许有两套语义 */
const { scanText, autoFixText } = require('../../lib/math-check.js');
export { scanText, autoFixText };

function main() {
  const strict = process.argv.includes('--strict');
  const files = fs.readdirSync(DATA_DIR).filter((f) => /^batch-.*\.json$/.test(f)).sort();
  let totalIssues = 0;
  let totalProblems = 0;
  let exemptIssues = 0;

  for (const file of files) {
    const exempt = EXEMPT[file];
    const full = path.join(DATA_DIR, file);
    let list;
    try { list = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) {
      console.log(`[${file}] 读取失败：${e.message}`);
      totalIssues++;
      continue;
    }
    let fileIssues = 0;
    for (const p of Array.isArray(list) ? list : list.problems || []) {
      totalProblems++;
      for (const f of FIELDS) {
        for (const e of scanText(p[f])) {
          fileIssues++;
          if (!exempt) console.log(`[${file}] ${p.code || p.title} -> ${f}: ${e}`);
        }
      }
      for (const [idx, h] of (p.hints || []).entries()) {
        for (const e of scanText(h)) {
          fileIssues++;
          if (!exempt) console.log(`[${file}] ${p.code || p.title} -> hints[${idx}]: ${e}`);
        }
      }
    }
    if (exempt) {
      exemptIssues += fileIssues;
      console.log(`[豁免] ${file}：${fileIssues} 处（${exempt}）`);
    } else {
      totalIssues += fileIssues;
    }
  }

  console.log(`\n共扫描 ${files.length} 个批次文件 / ${totalProblems} 题，发现 ${totalIssues} 处分隔符/环境异常。`);
  if (exemptIssues) console.log(`豁免文件另有 ${exemptIssues} 处（不计入门禁）。`);
  if (strict && totalIssues > 0) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main();
}
