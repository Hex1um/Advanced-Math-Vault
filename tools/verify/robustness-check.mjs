#!/usr/bin/env node
/**
 * 仓库鲁棒性体检（只读）
 *   node tools/verify/robustness-check.mjs
 *
 * 检查：重复编号、必填字段、标签体系、矩阵环境配对、控制字符、全字段 KaTeX、
 *      每日一题/帖子/提交/反馈/用户记录中的悬空题目引用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/* db.json 是 gitignore 的运行时库：新克隆 / CI 里没有它，退回仓库内的 batch 题库，
   这样「体检能不能跑」不取决于本机有没有跑过服务。 */
function loadDb() {
  const file = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
  if (fs.existsSync(file)) {
    return { db: JSON.parse(fs.readFileSync(file, 'utf8')), source: file };
  }
  const dir = path.join(ROOT, 'data');
  const problems = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^batch-.*\.json$/.test(x)).sort()) {
    const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (Array.isArray(arr)) problems.push(...arr);
  }
  if (!problems.length) {
    console.error('✗ 既没有 data/db.json，也没有 data/batch-*.json，体检无从进行');
    process.exit(2);
  }
  // batch 文件里没有编号与状态（导入时才分配），体检前补上占位值，
  // 否则「缺 code/status」会刷出一屏假错误
  const withMeta = problems.map((p, i) => Object.assign({ status: 'approved' }, p, {
    code: p.code || 'B' + String(i + 1).padStart(4, '0')
  }));
  console.log('未找到 data/db.json，改用 batch 题库：' + withMeta.length + ' 题（编号为占位）');
  return { db: { problems: withMeta }, source: 'batch' };
}

const loaded = loadDb();
const db = loaded.db;
const tax = require(path.join(ROOT, 'tag-taxonomy.js'));
/* docs/ 已不再入库（改由 CI 构建），KaTeX 直接从 public/ 取 */
const katex = require(path.join(ROOT, 'public', 'vendor', 'katex', 'katex.min.js'));

const problems = db.problems || [];
const codes = new Set(problems.map((p) => p.code));
const errors = [];
const warns = [];
const seenCodes = new Set();
const fields = ['statement', 'solution', 'answer', 'hints'];

function fail(msg) { errors.push(msg); }
function warn(msg) { warns.push(msg); }

function textOf(v) { return Array.isArray(v) ? v.join('\n') : String(v || ''); }
function mathSegments(text) {
  const s = String(text || ''), out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === '$') {
      const end = s.indexOf('$$', i + 2);
      if (end > 0) { out.push({ tex: s.slice(i + 2, end), display: true }); i = end + 2; continue; }
    }
    if (s[i] === '$') {
      let j = i + 1, closed = -1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '$') { closed = j; break; }
        j++;
      }
      if (closed > 0) { out.push({ tex: s.slice(i + 1, closed), display: false }); i = closed + 1; continue; }
    }
    i++;
  }
  return out;
}

let matrices = 0, mathSegmentsCount = 0;
for (const p of problems) {
  if (!p.code || !p.title || !p.statement) fail(p.code || '(无编号) 缺少 code/title/statement');
  if (seenCodes.has(p.code)) fail('重复题号 ' + p.code);
  seenCodes.add(p.code);
  /* 按学科取标签体系：物理题走 PHYSICS 表，数学题走 MATH 表。
     混用会得到「力学不是合法主标签」这种假错误（v2.7.0 之前的体检逻辑）。 */
  const subject = tax.subjectOf(p.subject);
  const spec = tax.SUBJECTS[subject];
  if (!spec.mainTags.includes(p.mainTag)) fail(p.code + ' 主标签非法: ' + p.mainTag + '（学科 ' + subject + '）');
  if (!Array.isArray(p.tags) || !p.tags.length) fail(p.code + ' 没有子标签');
  if (Array.isArray(p.tags) && p.tags.length > 3) warn(p.code + ' 子标签超过 3 个');
  for (const t of p.tags || []) {
    if (!spec.subTags[p.mainTag] || !spec.subTags[p.mainTag].includes(t)) warn(p.code + ' 子标签不在主标签下: ' + t);
  }
  if (!['approved', 'pending', 'rejected'].includes(p.status)) fail(p.code + ' 状态非法: ' + p.status);
  for (const k of ['thinking', 'difficulty', 'calc']) {
    const n = Number(p[k]);
    if (!Number.isFinite(n) || n < 1) fail(p.code + ' 评分非法: ' + k);
  }
  for (const f of fields) {
    const v = textOf(p[f]);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)) fail(p.code + ' ' + f + ' 含控制字符');
    const b = (v.match(/\\begin\{bmatrix\}/g) || []).length;
    const e = (v.match(/\\end\{bmatrix\}/g) || []).length;
    if (b !== e) fail(p.code + ' ' + f + ' bmatrix 不配对 ' + b + '/' + e);
    const vb = (v.match(/\\begin\{vmatrix\}/g) || []).length;
    const ve = (v.match(/\\end\{vmatrix\}/g) || []).length;
    if (vb !== ve) fail(p.code + ' ' + f + ' vmatrix 不配对 ' + vb + '/' + ve);
    matrices += b + vb;
    for (const seg of mathSegments(v)) {
      mathSegmentsCount++;
      try {
        katex.renderToString(seg.tex, {
          displayMode: seg.display, throwOnError: true, strict: false,
          macros: { '\\arccot': '\\operatorname{arccot}', '\\arcsec': '\\operatorname{arcsec}', '\\arccsc': '\\operatorname{arccsc}' }
        });
      } catch (err) {
        fail(p.code + ' ' + f + ' KaTeX: ' + String(err.message).split('\n')[0].slice(0, 100));
      }
    }
  }
}

/* 关联数据悬空检查 */
for (const [date, code] of Object.entries(db.daily || {})) {
  if (code && !codes.has(code)) fail('每日一题 ' + date + ' 指向不存在题目 ' + code);
}
for (const post of db.posts || []) {
  if (post.problemCode && !codes.has(post.problemCode)) fail('帖子 ' + post.id + ' 指向不存在题目 ' + post.problemCode);
}
for (const sub of db.submissions || []) {
  if (sub.code && !codes.has(sub.code) && !sub.problemDeleted) fail('提交 ' + sub.id + ' 指向不存在题目 ' + sub.code);
}
for (const fb of db.feedbacks || []) {
  if (fb.code && !codes.has(fb.code) && !fb.problemDeleted) fail('反馈 ' + fb.id + ' 指向不存在题目 ' + fb.code);
}
for (const u of db.users || []) {
  for (const key of ['solved', 'best', 'wrong']) {
    for (const code of Object.keys(u[key] || {})) {
      if (!codes.has(code)) fail('用户 ' + u.name + '.' + key + ' 指向不存在题目 ' + code);
    }
  }
}

console.log(JSON.stringify({
  problems: problems.length,
  approved: problems.filter((p) => p.status === 'approved').length,
  pending: problems.filter((p) => p.status === 'pending').length,
  code: seenCodes.size,
  matrices,
  mathSegments: mathSegmentsCount,
  errors: errors.length,
  warnings: warns.length
}, null, 2));
if (errors.length) {
  console.log('\n错误：');
  for (const e of errors.slice(0, 30)) console.log(' ✗ ' + e);
}
if (warns.length) {
  console.log('\n警告：');
  for (const w of warns.slice(0, 20)) console.log(' ! ' + w);
}
process.exit(errors.length ? 1 : 0);
