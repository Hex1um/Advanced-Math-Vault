#!/usr/bin/env node
/* 用项目自带的 physicsGate 逐题检查生成批次（只报告，不改文件） */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const gate = await import('../import/gate.mjs');
const physics = require('../../lib/physics-equiv.js');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法: node tools/verify/check-physics-batch.mjs data/batch-xx.json ...');
  process.exit(1);
}

let total = 0;
let bad = 0;
const reasons = {};
for (const f of files) {
  const list = JSON.parse(fs.readFileSync(f, 'utf8'));
  const arr = Array.isArray(list) ? list : list.problems || [];
  for (const p of arr) {
    total++;
    const errs = gate.physicsGate(p, { root: process.cwd() });
    if (errs.length) {
      bad++;
      for (const e of errs) reasons[e.split('：')[0]] = (reasons[e.split('：')[0]] || 0) + 1;
      if (bad <= 12) console.log('✗ ' + path.basename(f) + ' | ' + p.title + ' → ' + errs.join('；'));
    }
  }
}
console.log(`\n共检查 ${total} 题，硬错误 ${bad} 题（${(100 * bad / total).toFixed(2)}%）`);
if (bad) for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log('  · ' + k + '：' + v);
process.exit(bad ? 1 : 0);
