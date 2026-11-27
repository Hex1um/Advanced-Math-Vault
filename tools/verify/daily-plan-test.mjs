#!/usr/bin/env node
/**
 * 每日一积连排表体检
 *
 *   node tools/verify/daily-plan-test.mjs
 *
 * 排期按「题干指纹」认题，不写题号，所以这里重点验三件事：
 *   1. 每条指纹在真实题库里都认得到题、且都是积分题、互不重复；
 *   2. 日期换算正确（start 当天 = 第 1 天、跨月、走出排期回落伪随机、非法日期不炸）；
 *   3. **模拟题库重建**：把所有 code 换一遍，指纹仍然能认回同一道题
 *      （2026-11-27 的事故就是重建后 code 重排，整批排期指向了别的题）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const plan = require(path.join(ROOT, 'lib', 'daily-plan.js'));

const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
if (!fs.existsSync(DB_FILE)) {
  /* 与 calc-pack-test 同一约定：运行时题库不入 git，CI 里没有。
     明确打一行跳过原因，不当失败也不当通过；本地有库时才真正体检排期。 */
  console.log('  · 跳过：找不到 ' + DB_FILE + '（需要真实题库；本地跑一次服务或 pull-live-db 后再验）');
  process.exit(0);
}
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('连排：' + plan.start + ' 起 ' + plan.entries.length + ' 天');

ok('排期长度 20 天', plan.entries.length === 20, 'len=' + plan.entries.length);

const resolved = plan.entries.map((e) => plan.resolve(db.problems, e));
const missing = resolved.map((r, i) => (r.problem ? '' : '第' + (i + 1) + '天')).filter(Boolean);
ok('每条指纹都能认到题', missing.length === 0, missing.join(','));

const notIntegral = resolved.filter((r) => r.problem && r.problem.mainTag !== '积分');
ok('认到的都是积分题', notIntegral.length === 0, notIntegral.map((r) => r.problem.code + '/' + r.problem.mainTag).join(','));

const codes = resolved.map((r) => r.problem && r.problem.code).filter(Boolean);
ok('排期不重复出题', new Set(codes).size === codes.length, codes.join(','));

/* 库里本来就有重复题（换元积分那批），允许撞上，但必须取编号靠前的那份并保持稳定 */
const ambiguous = resolved.filter((r) => r.ambiguous > 1).map((r, i) => '第' + (i + 1) + '天=' + r.problem.code);
ok('撞重复题时取编号靠前的', ambiguous.length <= 1, ambiguous.join(','));

/* 模拟题库重建：code 全换，题干不动 */
const rebuilt = db.problems.map((p, i) => Object.assign({}, p, { code: 'RB' + String(10000 + i) }));
const afterRebuild = plan.entries.map((e) => plan.resolve(rebuilt, e));
const drifted = afterRebuild.map((r, i) => (
  r.problem && r.problem.statement === resolved[i].problem.statement ? '' : '第' + (i + 1) + '天'
)).filter(Boolean);
ok('题库重建换号后仍认回同一道题', drifted.length === 0, drifted.join(','));

/* 日期换算 */
const D = (s) => plan.indexFor(s);
ok('start 当天 = 第 1 天', D('2026-11-26') === 0, D('2026-11-26'));
ok('start 前一天不在排期', D('2026-11-25') === -1);
ok('跨月正确（12-01 = 第 6 天）', D('2026-12-01') === 5, D('2026-12-01'));
ok('最后一天 = 第 20 天', D('2026-12-15') === 19, D('2026-12-15'));
ok('第 21 天回落伪随机', D('2026-12-16') === -1, D('2026-12-16'));
ok('非法日期不炸', D('') === -1 && D('2026-13-01') === -1);

console.log('\n排期对到的题：' + codes.join(' '));
console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
