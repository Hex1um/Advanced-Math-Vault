#!/usr/bin/env node
/**
 * 用真 KaTeX 校验题库里的每个数学片段能不能渲染。只报告，不改数据。
 *
 *   node tools/verify/check-katex.mjs                     # 校验 data/db.json（没有则用 batch 题库）
 *   node tools/verify/check-katex.mjs --detail            # 打印失败样例
 *   node tools/verify/check-katex.mjs --file data/batch-01.json
 *   node tools/verify/check-katex.mjs --sqlite            # 直接读 data/db.sqlite（或 data/vault.db）
 *   node tools/verify/check-katex.mjs --sqlite path/to.db
 *   node tools/verify/check-katex.mjs --field solution    # 只查某个字段
 *   node tools/verify/check-katex.mjs --json              # 机器可读报告
 *   node tools/verify/check-katex.mjs --max-fail=0        # CI 门禁
 *
 * v1.3.1 的盲区：只查 statement，漏了 title / answer / solution / hints 里成片的公式；
 * 不认 \(...\) 与 \[...\]；未闭合的 $ 被整段静默跳过（题库里最典型的坏数据反而漏检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const argv = process.argv.slice(2);
const HAS = (n) => argv.includes('--' + n);
const ARG = (n, def) => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return def;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const DETAIL = HAS('detail');
const JSON_OUT = HAS('json');
const FIELD_ONLY = ARG('field', null);
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');

/* docs/ 不进仓库后，KaTeX 从 public/ 取；仍允许 KATEX_DIR 覆盖 */
const katexDir = process.env.KATEX_DIR || path.join(ROOT, 'public', 'vendor', 'katex');
const katexFile = path.join(katexDir, 'katex.min.js');
if (!fs.existsSync(katexFile)) {
  console.error('找不到本地 KaTeX: ' + katexFile);
  process.exit(2);
}
const require = createRequire(import.meta.url);
const katex = require(katexFile);

/* 富文本字段：一个都别漏 */
const FIELDS = ['title', 'statement', 'answer', 'solution'];

/**
 * 切出所有数学片段。
 * 支持 $$...$$ / $...$ / \[...\] / \(...\)；跳过围栏代码与转义 \$；
 * 未闭合的分隔符单独记一条错误（UNCLOSED_DELIMITER），不再静默跳过。
 */
export function segments(text) {
  const src = String(text == null ? '' : text);
  const out = [];
  const unclosed = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('```', i)) {
      const end = src.indexOf('```', i + 3);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (src[i] === '\\') {
      const nx = src[i + 1];
      if (nx === '[') {
        // \[6pt] / \[2mm] 是 LaTeX 的行间距换行，不是公式开始
        const spacing = /^\\\[[0-9.]+(?:pt|mm|cm|em|ex|in|pc)?\]/.exec(src.slice(i, i + 16));
        if (spacing) { i += spacing[0].length; continue; }
        const end = src.indexOf('\\]', i + 2);
        if (end < 0) { unclosed.push({ delim: '\\[', at: i }); break; }
        out.push({ display: true, tex: src.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
      if (nx === '(') {
        const end = src.indexOf('\\)', i + 2);
        if (end < 0) { unclosed.push({ delim: '\\(', at: i }); break; }
        out.push({ display: false, tex: src.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
      i += 2; // \$ \\ 等转义，跳过被转义的字符
      continue;
    }
    if (src[i] === '$') {
      if (src[i + 1] === '$') {
        const end = src.indexOf('$$', i + 2);
        if (end < 0) { unclosed.push({ delim: '$$', at: i }); break; }
        out.push({ display: true, tex: src.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
      // 行内公式允许跨行：题库里的题干是硬换行的，KaTeX 的 auto-render 也认跨行 $...$
      let j = i + 1;
      let closed = -1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '$') { closed = j; break; }
        j++;
      }
      if (closed > 0) {
        out.push({ display: false, tex: src.slice(i + 1, closed) });
        i = closed + 1;
        continue;
      }
      // 行内公式没闭合：这一行剩余部分整体不可信，记一条就跳过整行，
      // 否则后面每个 $ 都会翻转奇偶，一次坏数据能刷出几十条误报。
      unclosed.push({ delim: '$', at: i });
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    i++;
  }
  return { segments: out, unclosed };
}

/* ------------------------------------------------------------ 取数据源 */
function loadProblems() {
  const src = ARG('sqlite', null);
  if (src !== null && src !== undefined) {
    const candidates = typeof src === 'string'
      ? [path.resolve(src)]
      : [path.join(ROOT, 'data', 'vault.db'), path.join(ROOT, 'data', 'db.sqlite')];
    const file = candidates.find((f) => fs.existsSync(f));
    if (!file) {
      console.error('✗ 找不到 SQLite 库：' + candidates.join(' 或 '));
      process.exit(2);
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    try {
      const rows = db.prepare('SELECT k, body FROM problems ORDER BY rowid').all();
      console.error('[check-katex] 从 ' + file + ' 读取 ' + rows.length + ' 题');
      return rows.map((r) => {
        try { return JSON.parse(r.body); } catch (e) { return null; }
      }).filter(Boolean);
    } finally {
      try { db.close(); } catch (e) {}
    }
  }

  const file = ARG('file', null);
  if (file) {
    const abs = path.resolve(process.cwd(), String(file));
    if (!fs.existsSync(abs)) {
      console.error('✗ 文件不存在：' + abs);
      process.exit(2);
    }
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.problems;
    if (!Array.isArray(list)) {
      console.error('✗ ' + abs + ' 既不是数组也不是 { problems: [...] }');
      process.exit(2);
    }
    return list;
  }

  if (fs.existsSync(DB_FILE)) {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).problems || [];
  }
  // 新克隆没有运行时 db.json：退回仓库内的 batch 题库，保证脚本开箱可跑
  const dir = path.join(ROOT, 'data');
  let problems = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^batch.*\.json$/.test(x)).sort()) {
    const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (Array.isArray(arr)) problems = problems.concat(arr);
  }
  console.error('[check-katex] 未找到 data/db.json，改用 batch 题库：' + problems.length + ' 题');
  return problems;
}

const problems = loadProblems();

let badProblems = 0;
let badSegs = 0;
let totalSegs = 0;
let unclosedCount = 0;
const samples = [];
const byReason = {};
const byField = {};

function bumpField(field, key) {
  if (!byField[field]) byField[field] = { total: 0, bad: 0, unclosed: 0 };
  if (key === 'total') byField[field].total++;
  else if (key === 'unclosed') byField[field].unclosed++;
  else byField[field].bad++;
}

function checkText(code, field, text) {
  if (!text) return 0;
  if (FIELD_ONLY && field !== FIELD_ONLY) return 0;
  const { segments: segs, unclosed } = segments(text);
  let bad = 0;

  for (const u of unclosed) {
    // 未闭合单独计数：历史题库（batch-hust 的 PDF 抽取结果）里有一批天然缺尾巴的块，
    // 它们不会让 KaTeX 崩，只是那一段渲染成源码。默认只报告，
    // 需要卡住新数据时用 --strict-unclosed（gate.mjs 对新导入的题就是这么跑的）。
    unclosedCount++;
    bumpField(field, 'unclosed');
    const msg = 'UNCLOSED_DELIMITER ' + u.delim;
    byReason[msg] = (byReason[msg] || 0) + 1;
    if (samples.length < (DETAIL ? 25 : 5)) {
      samples.push({ code, field, tex: String(text).slice(Math.max(0, u.at - 20), u.at + 40), msg });
    }
  }

  for (const seg of segs) {
    totalSegs++;
    bumpField(field, 'total');
    if (!seg.tex.trim()) continue;
    try {
      katex.renderToString(seg.tex, { displayMode: seg.display, throwOnError: true, strict: false });
    } catch (e) {
      bad++;
      badSegs++;
      bumpField(field, 'bad');
      const msg = String(e.message).split('\n')[0].slice(0, 90);
      byReason[msg] = (byReason[msg] || 0) + 1;
      if (samples.length < (DETAIL ? 25 : 5)) samples.push({ code, field, tex: seg.tex.slice(0, 60), msg });
    }
  }
  return bad;
}

for (const p of problems) {
  let bad = 0;
  for (const f of FIELDS) bad += checkText(p.code, f, p[f]);
  if (Array.isArray(p.hints)) {
    p.hints.forEach((h, i) => { bad += checkText(p.code, 'hints[' + i + ']', h); });
  }
  if (bad) badProblems++;
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    problems: problems.length,
    segments: totalSegs,
    failedSegments: badSegs,
    unclosed: unclosedCount,
    affectedProblems: badProblems,
    byField,
    byReason,
    samples
  }, null, 2));
} else {
  console.log('题数 ' + problems.length + ' | 数学片段 ' + totalSegs + ' | 渲染失败 ' + badSegs
    + '（其中未闭合分隔符 ' + unclosedCount + '） | 受影响题目 ' + badProblems);
  console.log('按字段：');
  for (const [f, st] of Object.entries(byField).sort((a, b) => b[1].bad - a[1].bad)) {
    console.log('  ' + f.padEnd(12) + ' 片段 ' + String(st.total).padStart(5)
      + '  失败 ' + String(st.bad).padStart(3) + '  未闭合 ' + String(st.unclosed).padStart(3));
  }
  if (Object.keys(byReason).length) {
    console.log('失败原因 TOP:');
    Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k, v]) => console.log('  ', v, k));
  }
  for (const s of samples) console.log('  -', s.code, '|', s.field || '', '|', s.tex, '|', s.msg);
}

/* CI 用：--max-fail=0 时，只要有一个片段渲染不了就非零退出 */
const maxFlag = (argv.find((a) => a.startsWith('--max-fail=')) || '').split('=')[1];
if (maxFlag !== undefined) {
  const max = Number(maxFlag);
  if (Number.isFinite(max) && badSegs > max) {
    console.error('✗ 渲染失败片段 ' + badSegs + ' 个，超过允许上限 ' + max);
    process.exit(1);
  }
  if (!JSON_OUT) console.log('✓ 渲染失败片段在允许上限内（' + badSegs + ' ≤ ' + max + '）');
}
/* 新数据（gate.mjs 导入前）要求没有未闭合分隔符；历史题库按报告处理 */
if (HAS('strict-unclosed') && unclosedCount > 0) {
  console.error('✗ 有 ' + unclosedCount + ' 处未闭合的 $ / $$ / \[ / \(');
  process.exit(1);
}
