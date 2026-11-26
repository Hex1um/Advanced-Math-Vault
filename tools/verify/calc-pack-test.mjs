#!/usr/bin/env node
/**
 * 科目包体检（用真实题库跑，不依赖冒烟库）
 *
 *   node tools/verify/calc-pack-test.mjs
 *
 * 冒烟测试跑在 10 道示例题的库里，引用型科目包（微积分真题）解析不到题号，
 * 只能证明「包能加载」。这里用 data/db.json 真库校验：
 *   - 两个包都能加载，零校验错误
 *   - 习概包考点/题量、题型分布、答案合法性
 *   - 微积分包引用是否全部命中题库、真题占比、每个考点的题量
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const createSprint = require(path.join(ROOT, 'lib', 'sprint.js'));

const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
if (!fs.existsSync(DB_FILE)) {
  console.error('找不到 ' + DB_FILE + '，先在本地跑一次服务或用 tools/ops/backup 恢复库');
  process.exit(2);
}
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

const logs = [];
const spr = createSprint({ dir: path.join(ROOT, 'data', 'subjects'), getDb: () => db, log: (m) => logs.push(m) });
const res = spr.load();

console.log('题库 ' + (db.problems || []).length + ' 题；科目包加载 ' + res.loaded + ' 个');
ok('科目包零校验错误', res.errors.length === 0, res.errors.slice(0, 2).join(' / '));

/* ---------------------------------------------------------------- 习概 */
const xg = spr.get('hust-xigai-2026');
ok('习概包存在', !!xg);
if (xg) {
  ok('考点数 ≥ 90', xg.points.length >= 90, 'points=' + xg.points.length);
  ok('题量 ≥ 150', xg.questions.length >= 150, 'questions=' + xg.questions.length);
  const byType = xg.counts.byType;
  ok('五种题型齐全', ['single', 'judge', 'short', 'essay', 'material'].every((t) => byType[t] > 0),
    JSON.stringify(byType));
  const badAnswer = xg.questions.filter((q) => q.type === 'single' && !/^[A-D]$/.test(q.answer));
  ok('选择题答案合法', badAnswer.length === 0, badAnswer.slice(0, 3).map((q) => q.id).join(','));
  const noExplain = xg.questions.filter((q) => !q.explain);
  ok('每题都有解析', noExplain.length === 0, noExplain.slice(0, 3).map((q) => q.id).join(','));
  const emptyPoint = xg.points.filter((p) => !p.questionIds.length);
  ok('每个考点至少 1 道题', emptyPoint.length === 0, emptyPoint.slice(0, 3).map((p) => p.id).join(','));
  const noExamType = xg.points.filter((p) => !p.examTypes.length);
  ok('每个考点都标注了常考题型', noExamType.length === 0, noExamType.slice(0, 3).map((p) => p.id).join(','));
  /* 章节权重与考点数不应倒挂：权重高的章至少要有 3 个考点 */
  const thin = xg.chapters.filter((c) => c.weight >= 5 && c.pointIds.length < 3);
  ok('重点章节考点充足', thin.length === 0, thin.map((c) => c.title).join(' / '));
}

/* ---------------------------------------------------------------- 微积分 */
const cb = spr.get('hust-calculus-b-2026');
ok('微积分包存在', !!cb);
if (cb) {
  ok('考点数 ≥ 30', cb.points.length >= 30, 'points=' + cb.points.length);
  ok('引用真题 ≥ 100', cb.counts.questions >= 100, 'questions=' + cb.counts.questions);
  ok('真题占比 ≥ 90%', cb.counts.past / Math.max(1, cb.counts.questions) >= 0.9,
    'past=' + cb.counts.past + '/' + cb.counts.questions);
  const emptyPoint = cb.points.filter((p) => !p.questionIds.length);
  console.log('    零题考点 ' + emptyPoint.length + '：' + (emptyPoint.map((p) => p.title).join('、') || '无'));
  ok('零题考点不超过 2 个', emptyPoint.length <= 2, emptyPoint.map((p) => p.id).join(','));
  const noRef = cb.questions.filter((q) => q.fromBank && !q.bankCode);
  ok('引用题都解析到题库编号', noRef.length === 0);
  const sim = spr.similar(cb, { pointId: 'p5-2', limit: 3 });
  ok('变限积分考点能捞到题', sim.items.length >= 1 && sim.items.some((q) => q.isPast));
}

const dupWarn = logs.filter((m) => /重复|不存在/.test(m));
ok('加载日志无重复/缺号告警', dupWarn.length === 0, dupWarn.slice(0, 2).join(' / '));

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
