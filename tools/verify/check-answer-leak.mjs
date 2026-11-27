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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

/* 没有 data/db.json 时 loadDb 会「建空库并落盘」。若让它落在 data/db.json，
   后面跑 check:sprint / check:daily 的进程就会拿到一个只有 10 道种子题的假库，
   报出一堆莫名奇妙的失败。改指临时目录，用完删掉。 */
let TEMP_DB = '';
if (!process.env.DB_FILE && !fs.existsSync(path.join(ROOT, 'data', 'db.json'))) {
  TEMP_DB = path.join(os.tmpdir(), 'mv-leak-check-' + process.pid + '.json');
  process.env.DB_FILE = TEMP_DB;
}

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
const isPhysics = (p) => (p.subject || 'math') === 'physics';

/* db.json 是 gitignore 的运行时库：新克隆 / CI 里没有它，core 会给出空库。
   这时退回仓库内的 batch 题库（与体检脚本同一套口径），
   否则「库里有物理题可测」会变成对运行环境的抱怨，而不是对代码的检查。 */
if (!db.problems.some((p) => isPhysics(p) && p.answer)) {
  const dir = path.join(ROOT, 'data');
  const fromBatch = [];
  try {
    for (const f of fs.readdirSync(dir).filter((x) => /^batch-.*\.json$/.test(x)).sort()) {
      const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (Array.isArray(arr)) fromBatch.push(...arr);
    }
  } catch (e) { /* 目录不存在就保持空库 */ }
  if (fromBatch.length) {
    db.problems = fromBatch.map((p, i) => Object.assign({ status: 'approved' }, p, {
      code: p.code || 'B' + String(i + 1).padStart(4, '0')
    }));
    console.log('  未找到含物理题的 db.json，改用 batch 题库：' + db.problems.length + ' 题');
  }
}

let physics = db.problems.filter((p) => isPhysics(p) && p.answer);
let math = db.problems.filter((p) => !isPhysics(p) && p.answer);

/* CI 上没有 data/db.json（运行时库不进 git），本地新 clone 也没有。
   这时不能「空跑通过」（等于没检查），也不该直接失败 —— 直接从入库批次文件取样：
   线上的题本来就来自这些文件，字段结构一致，visibleProblem / fullProblem 只看单个对象。 */
function loadBatches(wantPhysics, prefix) {
  const dir = path.join(ROOT, 'data');
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    if (!/^batch-.*\.json$/.test(name)) continue;
    if (/physics/.test(name) !== wantPhysics) continue;
    let arr;
    try { arr = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (e) { continue; }
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      if (!p || !p.answer) continue;
      const subject = p.subject || (wantPhysics ? 'physics' : 'math');
      if ((subject === 'physics') !== wantPhysics) continue;
      out.push(Object.assign({}, p, { code: p.code || prefix + String(out.length + 1).padStart(4, '0') }));
    }
  }
  return out;
}

if (!physics.length) {
  physics = loadBatches(true, 'CI-PHY-');
  console.log('  · 库里没有物理题，改用 data/batch-physics*.json 取样（' + physics.length + ' 题）');
}
if (!math.length) math = loadBatches(false, 'CI-MATH-');

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
if (TEMP_DB) { try { fs.unlinkSync(TEMP_DB); } catch (e) { /* 已不存在 */ } }
process.exit(fail ? 1 : 0);
