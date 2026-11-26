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
const physics = require(path.join(ROOT, 'lib', 'physics-equiv.js'));
/* 占位词检测：物理题干里「忽略空气阻力」「略去边缘效应」是正常表述，
   不能把「略」当没写完。这里用前后文排除掉这些正常用法。 */
const PLACEHOLDER = /(待补|TODO|TBD|见解析|详见|同上|(?<![忽略省简粗战策大])略(?![过错去微])|^略$)/i;

/* 危险 SVG：直接拒绝，而不是「进库后审核再看」。
   <foreignObject> 能嵌 HTML，on* 事件能执行脚本，都是题库配图的经典 XSS 入口。 */
const SVG_DANGER = [
  [/<script[\s>]/i, '<script>'],
  [/\son[a-z]+\s*=/i, 'on* 事件属性'],
  [/<foreignObject[\s>]/i, '<foreignObject>'],
  [/<iframe[\s>]/i, '<iframe>'],
  [/xlink:href\s*=\s*["']?\s*(?:javascript:|data:text\/html)/i, 'javascript: / data:text/html 外链']
];

/**
 * 物理题专项门禁。
 * 返回错误数组（非空即拒绝入库）：与数学门禁的「软标记」不同，
 * 这里的错误都是确定性的（标签不属于物理体系、配图断链、单位解析不了）。
 */
export function physicsGate(p, opts) {
  const errors = [];
  const options = opts || {};
  const root = options.root || ROOT;
  const meta = (p && p.physicsMeta) || {};
  const spec = tagTax.SUBJECTS.physics;

  if (!Object.prototype.hasOwnProperty.call(p, 'subject')) errors.push('物理题必须显式声明 subject: "physics"');
  const main = String(p.mainTag || '').trim();
  if (main && !spec.mainTags.includes(main)) errors.push('物理主标签非法：' + main);
  if (main) {
    const allowed = new Set(spec.subTags[main] || []);
    for (const t of (p.tags || [])) {
      if (!allowed.has(String(t))) errors.push('子标签「' + t + '」不属于物理主标签「' + main + '」');
    }
  }

  const type = String(meta.answerType || '');
  if (type && !['symbolic', 'numeric_unit', 'vector', 'choice', 'proof', 'lab_analysis'].includes(type)) {
    errors.push('answerType 非法：' + type);
  }

  /* 配图：路径必须落在 public/assets/diagrams/physics/ 内，文件真实存在，SVG 安全，且有体积上限 */
  for (const d of (Array.isArray(meta.diagrams) ? meta.diagrams : [])) {
    const src = String((d && d.src) || '');
    if (!src) { errors.push('配图条目缺 src'); continue; }
    if (!/^assets\/diagrams\/physics\/[\w./-]+\.(svg|webp|png|jpg)$/i.test(src) || src.includes('..')) {
      errors.push('配图路径不合法（只允许 assets/diagrams/physics/ 下的相对路径）：' + src);
      continue;
    }
    const abs = path.join(root, 'public', src.replace(/\//g, path.sep));
    if (!fs.existsSync(abs)) { errors.push('配图不存在（断链）：' + src); continue; }
    const stat = fs.statSync(abs);
    if (stat.size > 300 * 1024) errors.push('配图过大（' + Math.round(stat.size / 1024) + ' KB > 300 KB）：' + src);
    if (/\.svg$/i.test(src)) {
      const text = fs.readFileSync(abs, 'utf8');
      for (const [re, label] of SVG_DANGER) {
        if (re.test(text)) errors.push('配图含危险内容（' + label + '）：' + src);
      }
    }
  }

  /* 单位可解析：numeric_unit 题的答案单位必须能被判题引擎认出来，否则学生永远判不对 */
  if (type === 'numeric_unit') {
    const unitText = String(meta.unit || '');
    if (!unitText) errors.push('answerType=numeric_unit 但缺少 physicsMeta.unit');
    else {
      const u = physics.parseUnitExpr(unitText);
      if (u.error) errors.push('physicsMeta.unit 无法解析：' + unitText);
    }
    if (!/[0-9]/.test(String(p.answer || ''))) errors.push('numeric_unit 题的答案里没有数值');
  }
  if (Number.isFinite(Number(meta.tolRel)) && (Number(meta.tolRel) < 0 || Number(meta.tolRel) > 0.5)) {
    errors.push('tolRel 必须在 0..0.5 之间（当前 ' + meta.tolRel + '）');
  }

  return errors;
}


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

  // 标签与三维评分：字段级硬伤必须在入库前拦下来（按学科取对应标签表）
  const subject = tagTax.subjectOf(p && p.subject);
  const spec = tagTax.SUBJECTS[subject];
  const main = String((p && p.mainTag) || '').trim();
  if (main && !spec.mainTags.includes(main)) return '主标签不在考点体系内：' + main;
  const tags = Array.isArray(p && p.tags) ? p.tags : [];
  const allowedSub = new Set();
  for (const m of spec.mainTags) for (const s of spec.subTags[m] || []) allowedSub.add(s);
  const badTag = tags.find((t) => !allowedSub.has(String(t)));
  if (badTag) return '子标签不在考点体系内：' + badTag;
  for (const [k, label] of [['thinking', '思维量'], ['difficulty', '难度'], ['calc', '计算量']]) {
    const v = p && p[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 10) return label + '必须是 1..10 的整数（当前 ' + v + '）';
  }

  /* 物理题的「能不能机器判」由量纲引擎决定，不套数学的积分/极限启发式 */
  if (subject === 'physics') {
    const meta = (p && p.physicsMeta) || {};
    if (String(meta.answerType || '') === 'numeric_unit' || String(meta.answerType || '') === 'numeric') {
      const chk = physics.checkAnswer(String(ans), String(ans), meta);
      if (chk.verdict === 'unitUnknown') return '答案单位无法解析：' + (meta.unit || '');
      if (chk.verdict === 'dimensionMismatch') return '答案量纲与声明单位不一致：' + (meta.unit || '');
      if (physics.canAutoJudge(p)) return '';
      return '数值题但机器判不了，需人工核对单位与容差';
    }
    if (String(meta.answerType || '') === 'symbolic') return '符号推导题，需人工核对建模与推导链';
    if (['lab_analysis', 'vector', 'proof', 'choice'].includes(String(meta.answerType || ''))) {
      return '题型为 ' + meta.answerType + '，需人工核对评分点';
    }
    return '物理题缺少 answerType，需人工复核';
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
export function markList(list, opts) {
  const out = { total: 0, flagged: 0, blocked: [], reasons: {} };
  for (const p of list || []) {
    out.total++;
    /* 物理题先过硬门禁：断链配图、非法 SVG、错学科标签这类问题是确定性错误，
       直接拒绝入库，不放进「待人工复核」——人能看出来的没必要让人再看一遍。 */
    if (tagTax.subjectOf(p && p.subject) === 'physics') {
      const errs = physicsGate(p, opts);
      if (errs.length) {
        out.blocked.push({ title: String((p && p.title) || ''), errors: errs });
        continue;
      }
    }
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
  ['tools/verify/verify_limits.py', '极限答案数值校验'],
  ['tools/verify/verify_physics.py', '物理量纲与单位校验']
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
  const stats = markList(list, { root: ROOT });
  console.log('\n共 ' + stats.total + ' 题，需人工复核 ' + stats.flagged + ' 题');
  if (stats.blocked.length) {
    console.error('\n✗ 物理门禁拒绝入库 ' + stats.blocked.length + ' 题：');
    for (const b of stats.blocked) {
      console.error('  · ' + (b.title || '(无标题)'));
      for (const e of b.errors) console.error('      - ' + e);
    }
  }
  for (const [reason, n] of Object.entries(stats.reasons).sort((a, b) => b[1] - a[1])) {
    console.log('  · ' + reason + '：' + n);
  }
  if (stats.blocked.length) {
    console.error('✗ 存在被门禁拒绝的物理题，请先修正后再入库');
    process.exit(1);
  }
  if (argv.includes('--write')) {
    const back = Array.isArray(parsed) ? list : Object.assign({}, parsed, { problems: list });
    fs.writeFileSync(abs, JSON.stringify(back, null, 2), 'utf8');
    console.log('\n已写回 ' + abs);
  } else {
    console.log('\n（未写盘）加 --write 把 needsReview 标记写回文件');
  }
}
