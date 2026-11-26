#!/usr/bin/env node
/**
 * 每日一积连排表体检
 *
 *   node tools/verify/daily-plan-test.mjs
 *
 * 校验 lib/daily-plan.js 里的排期与真实题库对得上：
 *   - 20 个题号都在库里、都 approved、互不重复、都是积分题
 *   - 新入库的 19 道（HS7542–HS7560）字段齐全、题干定界符配对
 *   - 日期换算：start 当天是第 1 题、跨月正确、走出 20 天后返回 -1（回落伪随机）
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
  console.error('找不到 ' + DB_FILE);
  process.exit(2);
}
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const byCode = new Map(db.problems.map((p) => [p.code, p]));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('连排：' + plan.start + ' 起 ' + plan.codes.length + ' 天');

ok('排期长度 20 天', plan.codes.length === 20, 'len=' + plan.codes.length);
ok('题号不重复', new Set(plan.codes).size === plan.codes.length);

const missing = plan.codes.filter((c) => !byCode.has(c));
ok('题号都在题库里', missing.length === 0, missing.join(','));
const notApproved = plan.codes.filter((c) => byCode.has(c) && byCode.get(c).status !== 'approved');
ok('排期题目都已过审', notApproved.length === 0, notApproved.join(','));
const notIntegral = plan.codes.filter((c) => {
  const p = byCode.get(c);
  return !p || p.mainTag !== '积分';
});
ok('排期题目都属于积分主题', notIntegral.length === 0, notIntegral.join(','));

/* 新入库的 19 道 */
const fresh = plan.codes.filter((c) => /^HS75(4[2-9]|5\d|60)$/.test(c));
ok('新入库 19 道在排期里', fresh.length === 19, 'fresh=' + fresh.length);
const badField = [];
for (const c of fresh) {
  const p = byCode.get(c);
  if (!p) continue;
  const dollars = (String(p.statement || '').match(/\$/g) || []).length;
  if (!p.answer || !p.solution || !(p.hints || []).length) badField.push(c + '(缺答案/解析/提示)');
  else if (dollars % 2) badField.push(c + '($ 不配对)');
  else if (!/\$/.test(p.answer)) badField.push(c + '(答案没写公式)');
}
ok('新题字段齐全', badField.length === 0, badField.slice(0, 4).join(' / '));

/* 日期换算 */
const D = (s) => plan.indexFor(s);
ok('start 当天 = 第 1 题', D('2026-11-26') === 0, D('2026-11-26'));
ok('start 前一天不在排期', D('2026-11-25') === -1);
ok('跨月正确（12-01 = 第 6 题）', D('2026-12-01') === 5, D('2026-12-01'));
ok('最后一天 = 第 20 题', D('2026-12-15') === 19, D('2026-12-15'));
ok('第 21 天回落伪随机', D('2026-12-16') === -1, D('2026-12-16'));
ok('非法日期不炸', D('') === -1 && D('2026-13-01') === -1);

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
