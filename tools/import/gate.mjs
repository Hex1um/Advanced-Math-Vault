#!/usr/bin/env node
/**
 * 入库门禁：把「自动能验算的」和「必须人工看的」分开
 *
 *   node tools/import/gate.mjs data/batch-01.json           # 只报告
 *   node tools/import/gate.mjs data/batch-01.json --write   # 把 needsReview 标记写回文件
 *
 * 两件事：
 *   1. 硬门禁：跑 tools/verify 下的符号/数值校验（积分求导、极限高精度），
 *      这两个脚本失败说明「已知答案的自检样例都过不了」，此时一律拒绝入库。
 *   2. 软标记：对每道题判断「这台机器能不能自动验算」。判不了的写
 *      needsReview + reviewReason，随题目一起入库，审核后台会显示「待验算」。
 *      这不是判错，而是把人工注意力放到真正需要人看的地方。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tagTax = require(path.join(ROOT, 'tag-taxonomy.js'));
const PLACEHOLDER = /(待补|TODO|TBD|略|见解析|详见|同上)/i;

/** 能不能自动验算：返回 '' 表示无需人工，非空表示需要人工复核的原因 */
export function reviewReason(p) {
  const st = String((p && p.statement) || '');
  const ans = String((p && p.answer) || '').trim();
  const sol = String((p && p.solution) || '').trim();

  if (!ans || /^(略|无|未给出|见解析|同上)$/.test(ans)) return '答案缺失，无法自动比对';
  if (!sol) return '没有解析，无法核对推导链';
  // 占位词不止会出现在答案里：题干写「详见教材」、解析写「略」，同样是没写完
  if (PLACEHOLDER.test(ans)) return '答案里有占位词（待补/TODO/略/见解析…）';
  if (PLACEHOLDER.test(sol)) return '解析里有占位词（待补/TODO/略/见解析…）';
  if (PLACEHOLDER.test(st)) return '题干里有占位词（待补/TODO/略/见解析…）';

  // 标签与三维评分：字段级硬伤必须在入库前拦下来
  const main = String((p && p.mainTag) || '').trim();
  if (main && !tagTax.isValidMain(main)) return '主标签不在考点体系内：' + main;
  const tags = Array.isArray(p && p.tags) ? p.tags : [];
  const allowedSub = new Set();
  for (const m of tagTax.MAIN_TAGS) for (const s of tagTax.SUB_TAGS[m] || []) allowedSub.add(s);
  const badTag = tags.find((t) => !allowedSub.has(String(t)));
  if (badTag) return '子标签不在考点体系内：' + badTag;
  for (const [k, label] of [['thinking', '思维量'], ['difficulty', '难度'], ['calc', '计算量']]) {
    const v = p && p[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 10) return label + '必须是 1..10 的整数（当前 ' + v + '）';
  }

  const heavy = [];
  if (/\\lim/.test(st)) heavy.push('极限');
  if (/\\iiint|\\iint|\\oint/.test(st)) heavy.push('重积分/曲线曲面积分');
  else if (/\\int\s*(?:_|\^)/.test(st)) heavy.push('定积分/反常积分');
  if (/\\sum/.test(st)) heavy.push('级数');
  if (heavy.length) return '含' + heavy.join('、') + '，需符号或数值验算';

  // 答案是纯文字结论（存在/不存在、收敛/发散、证明）时没法数值比对
  if (/[\u4e00-\u9fa5]/.test(ans) && !/\$/.test(ans)) return '答案是文字结论，需人工判断';

  return '';
}

/** 给一批题打标记，返回统计。不修改入参以外的数据 */
export function markList(list) {
  const out = { total: 0, flagged: 0, reasons: {} };
  for (const p of list || []) {
    out.total++;
    const reason = reviewReason(p);
    if (!reason) {
      delete p.needsReview;
      delete p.reviewReason;
      continue;
    }
    p.needsReview = true;
    p.reviewReason = reason.slice(0, 120);
    out.flagged++;
    out.reasons[reason] = (out.reasons[reason] || 0) + 1;
  }
  return out;
}

const PY_GATES = [
  ['tools/verify/verify_integrals.py', '积分答案求导校验'],
  ['tools/verify/verify_limits.py', '极限答案数值校验']
];

/**
 * 跑符号/数值自检。返回 {ok, results:[{name, ok, skipped, out}]}
 *
 * 关键变化：把待入库的 JSON 路径透传给 Python 脚本（旧实现只跑脚本自带的样例，
 * 根本不看这次要入库的题）；Python 缺失时按「跳过」记，--strict 下算失败。
 */
export function runPythonGates(opts) {
  const options = opts || {};
  const py = options.python || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const target = options.file ? path.resolve(options.file) : '';
  const results = [];
  for (const [file, name] of PY_GATES) {
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) {
      results.push({ name, ok: !options.strict, skipped: true, out: '脚本不存在：' + file });
      continue;
    }
    const args = [abs];
    if (target) args.push('--file', target);
    const r = spawnSync(py, args, { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
    if (r.error && /ENOENT/.test(String(r.error.code || r.error.message))) {
      results.push({ name, ok: false, skipped: true, out: '未找到 python（装 python3 + sympy/mpmath 后重试）' });
      continue;
    }
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    const tail = out.split('\n').slice(-3).join(' / ').slice(0, 300);
    results.push({ name, ok: r.status === 0, skipped: false, out: tail });
  }
  return { ok: results.every((x) => x.ok), results };
}

/** KaTeX 门禁：针对本次要入库的文件，且不允许未闭合分隔符 */
export function runKatexGate(file) {
  const script = path.join(ROOT, 'tools', 'verify', 'check-katex.mjs');
  const r = spawnSync(process.execPath, [script, '--file', path.resolve(file), '--max-fail=0', '--strict-unclosed'], {
    cwd: ROOT, encoding: 'utf8', timeout: 180000
  });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  return { name: 'KaTeX 公式渲染校验', ok: r.status === 0, skipped: false, out: out.split('\n').slice(-2).join(' / ').slice(0, 300) };
}

export function printGate(gate) {
  console.log('符号/数值自检：');
  for (const r of gate.results) {
    console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + r.name + (r.skipped ? '（跳过）' : '') + ' — ' + r.out);
  }
}

// ---------------------------------------------------------------- CLI
/* Windows 下 new URL(...).pathname 是 /C:/...，跟 process.argv[1] 永远不相等，
   导致 CLI 分支静默不执行（只导出函数）。统一走 fileURLToPath。 */
const isMain = (() => {
  const self = path.resolve(fileURLToPath(import.meta.url));
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return !!entry && entry === self;
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const STRICT = argv.includes('--strict') || process.env.MV_GATE_STRICT === '1';
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('用法: node tools/import/gate.mjs <题目.json> [--write] [--strict]');
    process.exit(1);
  }
  const abs = path.resolve(process.cwd(), file);
  const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : parsed.problems;
  if (!Array.isArray(list)) {
    console.error('文件内容必须是数组，或 { "problems": [...] }');
    process.exit(1);
  }
  const gate = runPythonGates({ file: abs, strict: STRICT });
  gate.results.push(runKatexGate(abs));
  printGate(gate);
  if (!gate.ok) {
    console.error('✗ 门禁未通过：' + (STRICT ? '（--strict：缺 Python 或跳过项也算失败）' : '先修校验脚本或答案再入库'));
    process.exit(1);
  }
  if (STRICT && gate.results.some((x) => x.skipped)) {
    console.error('✗ --strict 下存在被跳过的校验项');
    process.exit(1);
  }
  const stats = markList(list);
  console.log('\n共 ' + stats.total + ' 题，需人工复核 ' + stats.flagged + ' 题');
  for (const [reason, n] of Object.entries(stats.reasons).sort((a, b) => b[1] - a[1])) {
    console.log('  · ' + reason + '：' + n);
  }
  if (argv.includes('--write')) {
    const back = Array.isArray(parsed) ? list : Object.assign({}, parsed, { problems: list });
    fs.writeFileSync(abs, JSON.stringify(back, null, 2), 'utf8');
    console.log('\n已写回 ' + abs);
  } else {
    console.log('\n（未写盘）加 --write 把 needsReview 标记写回文件');
  }
}
