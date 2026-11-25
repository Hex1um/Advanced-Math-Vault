#!/usr/bin/env node
/**
 * FSRS-lite 调度器单测
 *
 *   node tools/verify/fsrs-test.mjs
 *
 * 断言的是「行为契约」而不是具体公式：单调性（简单 > 良好 > 吃力）、
 * 遗忘后间隔变短、难度有上下界、间隔有上限、旧数据兼容、同输入同输出。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const F = require(path.join(ROOT, 'lib', 'fsrs.js'));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

const T0 = 1764000000000; // 固定时间，保证可复现
const DAY = F.DAY;

console.log('\n[1] 首次复习');
const c1 = F.schedule(null, 'good', T0);
ok('新卡评价 good 后进入 learning', c1.state === 'learning', c1.state);
ok('间隔 = 2 天（初始稳定度 2.4）', c1.intervalDays === 2, c1.intervalDays);
ok('下次复习时间 = now + 间隔', c1.nextReviewAt === T0 + 2 * DAY, String(c1.nextReviewAt));
ok('reps = 1', c1.reps === 1);

console.log('\n[2] 单调性：简单 > 良好 > 吃力');
const hard = F.schedule(null, 'hard', T0).intervalDays;
const good = F.schedule(null, 'good', T0).intervalDays;
const easy = F.schedule(null, 'easy', T0).intervalDays;
ok('hard < good < easy', hard < good && good < easy, [hard, good, easy].join(' / '));

console.log('\n[3] 复习增长');
const r1 = F.schedule(c1, 'good', T0 + 2 * DAY);
ok('第二次 good 间隔变长', r1.intervalDays > c1.intervalDays, c1.intervalDays + ' → ' + r1.intervalDays);
ok('状态进入 review', r1.state === 'review', r1.state);
const r2 = F.schedule(r1, 'easy', T0 + 4 * DAY);
ok('easy 比 good 涨得更快', r2.stability > r1.stability);

console.log('\n[4] 遗忘');
const lapsed = F.schedule(r2, 'again', T0 + 6 * DAY);
ok('忘记后稳定度腰斩', lapsed.stability < r2.stability, r2.stability + ' → ' + lapsed.stability);
ok('lapses 累加', lapsed.lapses === 1, lapsed.lapses);
ok('间隔至少 1 天', lapsed.intervalDays >= 1, lapsed.intervalDays);
ok('状态标为 relearning 或 review', ['relearning', 'review'].indexOf(lapsed.state) >= 0, lapsed.state);

console.log('\n[5] 边界');
let c = null;
for (let i = 0; i < 40; i++) c = F.schedule(c, 'easy', T0 + i * DAY);
ok('间隔不超过 365 天上限', c.intervalDays <= F.MAX_STABILITY, c.intervalDays);
let d = null;
for (let i = 0; i < 30; i++) d = F.schedule(d, 'again', T0 + i * DAY);
ok('反复遗忘后难度不超过 10', d.difficulty <= 10, d.difficulty);
ok('反复遗忘后间隔不小于 1 天', d.intervalDays >= 1, d.intervalDays);
let up = null;
for (let i = 0; i < 30; i++) up = F.schedule(up, 'easy', T0 + i * DAY);
ok('反复简单后难度不低于 1', up.difficulty >= 1, up.difficulty);

console.log('\n[6] 兼容旧数据');
const legacy = { at: '2026-01-01T00:00:00Z', score: 55, tries: 3, intervalDays: 4, nextReviewAt: T0 + DAY };
const upgraded = F.schedule(legacy, 'good', T0);
ok('旧记录（只有 intervalDays）能接续增长', upgraded.intervalDays > 4, upgraded.intervalDays);
ok('旧记录的 tries/score 不被破坏', legacy.tries === 3 && legacy.score === 55);

console.log('\n[7] 确定性与评分别名');
const a = F.schedule(r1, 'good', T0 + 5 * DAY);
const b = F.schedule(r1, 'good', T0 + 5 * DAY);
ok('同输入同输出', JSON.stringify(a) === JSON.stringify(b));
ok('中文评分「简单」= easy', F.gradeToIndex('简单') === 3);
ok('数字评分 0 = again', F.gradeToIndex(0) === 0);
ok('非法评分回落 good', F.gradeToIndex('??') === 2);
ok('逾期天数计算', F.overdueDays({ nextReviewAt: T0 - 3 * DAY }, T0) === 3);
ok('未到期不算 due', F.isDue({ nextReviewAt: T0 + DAY }, T0) === false);

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
