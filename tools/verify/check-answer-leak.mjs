#!/usr/bin/env node
/**
 * 防漏答案检查
 *
 * 背景：物理题的 physicsMeta 里带一个 refAnswer（入库时留的排查字段，
 * 用来确认标准答案没被 mathify 改坏）。它是**服务端字段**，
 * 一旦随 /api/problems/:code 下发，未登录访客一行 curl 就能拿到标准答案，
 * 「先做题、点看答案扣经验」的所有规则都形同虚设。
 *
 * 本脚本直接调核心层的 visibleProblem / fullProblem，
 * 断言「未登录 / 没交过卷」视角下拿不到答案与解析，交过卷之后才拿得到。
 *
 *   node tools/verify/check-answer-leak.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const createCore = require('../../lib/core.js');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 把 LaTeX 里不影响语义的写法抹平，便于做「原文是否出现」的判断 */
function norm(s) {
  return String(s || '')
    .replace(/\\[ ,;:!]/g, ' ')
    .replace(/[{}$]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const core = createCore({});
core.loadDb();          // 读真实题库（只读用途，不做任何写入）
const db = core.db;

const physics = db.problems.filter((p) => (p.subject || 'math') === 'physics' && p.answer);
const math = db.problems.filter((p) => (p.subject || 'math') !== 'physics' && p.answer);
ok('库里有物理题可测', physics.length > 0, 'physics=' + physics.length);

if (physics.length) {
  const sample = physics.slice(0, 300);

  const detail = sample.map((p) => core.fullProblem(p, null));
  ok('匿名详情：不带 refAnswer',
    detail.every((x) => !x.physicsMeta || !('refAnswer' in x.physicsMeta)));
  ok('匿名详情：不带 answer / solution',
    detail.every((x) => !('answer' in x) && !('solution' in x)));

  const leaks = sample.filter((p, i) => {
    const target = norm(p.answer);
    if (target.length < 3) return false;
    return norm(JSON.stringify(detail[i])).indexOf(target) >= 0;
  });
  ok('匿名详情：答案原文没有混进其他字段', leaks.length === 0,
    leaks.slice(0, 3).map((p) => p.code).join(', '));

  const listed = sample.map((p) => core.visibleProblem(p, null));
  ok('列表视图：也不带 refAnswer',
    listed.every((x) => !x.physicsMeta || !('refAnswer' in x.physicsMeta)));

  const mine = { solved: {}, best: {} };
  mine.solved[sample[0].code] = { at: Date.now(), done: true, revealed: false };
  const own = core.fullProblem(sample[0], mine);
  ok('本人交过卷后可以拿到参考答案',
    !!own.physicsMeta && 'refAnswer' in own.physicsMeta);

  const peeked = { solved: {}, best: {} };
  peeked.solved[sample[1].code] = { at: Date.now(), done: false, revealed: true };
  const pv = core.fullProblem(sample[1], peeked);
  ok('点过「看答案」后同样可以拿到', !!pv.physicsMeta && 'refAnswer' in pv.physicsMeta);

  /* 别人做过不等于你能看：user 对象里只认自己那条记录 */
  const other = { solved: {}, best: {} };
  other.solved[physics[999] ? physics[999].code : 'NOPE'] = { at: Date.now(), done: true };
  const ov = core.fullProblem(sample[2], other);
  ok('别的题目的记录不会串到这道题', !ov.physicsMeta || !('refAnswer' in ov.physicsMeta));
}

if (math.length) {
  const m = core.fullProblem(math[0], null);
  ok('数学题匿名详情也不含 answer / solution', !('answer' in m) && !('solution' in m));
}

console.log('\n  ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 1 : 0);
