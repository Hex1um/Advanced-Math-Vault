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

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/** 能不能自动验算：返回 '' 表示无需人工，非空表示需要人工复核的原因 */
export function reviewReason(p) {
  const st = String((p && p.statement) || '');
  const ans = String((p && p.answer) || '').trim();
  const sol = String((p && p.solution) || '').trim();

  if (!ans || /^(略|无|未给出|见解析|同上)$/.test(ans)) return '答案缺失，无法自动比对';
  if (!sol) return '没有解析，无法核对推导链';

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
 * 跑符号/数值自检。返回 {ok, results:[{name, ok, out}]}
 * python 缺失（本机没装 sympy）时按「跳过」处理，不阻断本地录题。
 */
export function runPythonGates(opts) {
  const options = opts || {};
  const py = options.python || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const results = [];
  for (const [file, name] of PY_GATES) {
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) continue;
    const r = spawnSync(py, [abs], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
    if (r.error && /ENOENT/.test(String(r.error.code || r.error.message))) {
      results.push({ name, ok: true, skipped: true, out: '未找到 python，跳过（CI 里会真正执行）' });
      continue;
    }
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    const tail = out.split('\n').slice(-3).join(' / ').slice(0, 300);
    results.push({ name, ok: r.status === 0, out: tail });
  }
  return { ok: results.every((x) => x.ok), results };
}

export function printGate(gate) {
  console.log('符号/数值自检：');
  for (const r of gate.results) {
    console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + r.name + (r.skipped ? '（跳过）' : '') + ' — ' + r.out);
  }
}

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('用法: node tools/import/gate.mjs <题目.json> [--write]');
    process.exit(1);
  }
  const abs = path.resolve(process.cwd(), file);
  const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : parsed.problems;
  if (!Array.isArray(list)) {
    console.error('文件内容必须是数组，或 { "problems": [...] }');
    process.exit(1);
  }
  const gate = runPythonGates();
  printGate(gate);
  if (!gate.ok) {
    console.error('✗ 自检未通过，先修校验脚本或答案再入库');
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
