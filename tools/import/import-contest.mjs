#!/usr/bin/env node
/**
 * 导入《大学数学竞赛教程》各讲精选备赛练习。
 *
 *   node tools/import/import-contest.mjs            # 只报告
 *   node tools/import/import-contest.mjs --write    # 写入 data/db.json
 *
 * 读取 tmp/contest-parts/part*.json（子代理转写），做 KaTeX 校验 + 题库查重后入库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const tax = require(path.join(ROOT, 'tag-taxonomy.js'));
const katex = require(path.join(ROOT, 'docs', 'vendor', 'katex', 'katex.min.js'));
const WRITE = process.argv.includes('--write');
const PARTS = path.join(ROOT, 'tmp', 'contest-parts');
const DB_FILE = path.join(ROOT, 'data', 'db.json');
const REPORT_FILE = path.join(ROOT, 'data', 'contest-import-report.json');

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const files = fs.readdirSync(PARTS).filter((f) => /^part\d+\.json$/.test(f)).sort();
if (!files.length) { console.error('没有找到 tmp/contest-parts/part*.json'); process.exit(1); }

function canon(raw) {
  return String(raw || '').toLowerCase()
    .replace(/\\dfrac|\\tfrac/g, '\\frac')
    .replace(/\\(?:mathrm|mathbf|mathit|mathsf|mathtt|text|operatorname|mathbb|mathcal)\s*/g, '')
    .replace(/\\(?:left|right|limits|nolimits|displaystyle|textstyle)\b/g, '')
    .replace(/\\[a-zA-Z]+\*?/g, (m) => m.replace(/^\\/, ''))
    .replace(/\$/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；：、,.!?！？；：""''`（）()\[\]{}<>《》·—\-_/\\|]/g, '');
}
function grams(s) {
  const m = new Map();
  for (let i = 0; i + 1 < s.length; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) || 0) + 1);
  return m;
}
function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0, union = 0;
  for (const [g, n] of a) { const m = b.get(g) || 0; inter += Math.min(n, m); union += Math.max(n, m); }
  for (const [g, n] of b) if (!a.has(g)) union += n;
  return union ? inter / union : 0;
}
function katexSegments(text) {
  const s = String(text || ''), out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === '$') {
      const end = s.indexOf('$$', i + 2);
      if (end > 0) { out.push({ display: true, tex: s.slice(i + 2, end) }); i = end + 2; continue; }
    }
    if (s[i] === '$') {
      let j = i + 1, closed = -1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '$') { closed = j; break; }
        j++;
      }
      if (closed > 0) { out.push({ display: false, tex: s.slice(i + 1, closed) }); i = closed + 1; continue; }
    }
    i++;
  }
  return out;
}
function katexOk(p) {
  for (const field of ['statement', 'answer', 'solution']) {
    for (const seg of katexSegments(p[field])) {
      if (!seg.tex.trim()) continue;
      try { katex.renderToString(seg.tex, { displayMode: seg.display, throwOnError: true, strict: false }); }
      catch (e) { return { ok: false, field, error: String(e.message).split('\n')[0].slice(0, 120) }; }
    }
  }
  return { ok: true };
}
const clamp = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : def;
};

const existing = db.problems.map((p) => ({ p, canon: canon(p.statement), grams: null }));
const seen = new Map();
let seq = Math.max(Number(db.meta && db.meta.seq) || 1001,
  ...db.problems.map((p) => Number(String(p.code || '').replace(/\D/g, '')) || 0).filter(Boolean));
const used = new Set(db.problems.map((p) => p.code));
function allocCode() {
  let code;
  do { code = 'HS' + (seq++); } while (used.has(code));
  used.add(code);
  return code;
}
function findDup(problem) {
  const c = canon(problem.statement);
  if (!c) return null;
  const g = grams(c);
  let best = null;
  const check = (x) => {
    if (!x) return;
    if (!x.grams) x.grams = grams(x.canon);
    const sim = c.length < 12 || x.canon.length < 12 ? (c === x.canon ? 1 : 0) : jaccard(g, x.grams);
    if (sim >= 0.9 && (!best || sim > best.score)) best = { code: x.code || '', title: x.title || '', score: Math.round(sim * 100) };
  };
  for (const x of existing) check(x.p ? { code: x.p.code, title: x.p.title, canon: x.canon, grams: x.grams } : x);
  for (const x of seen.values()) check(x);
  return best;
}

const stats = { files: files.length, raw: 0, imported: 0, skipped: 0, duplicate: 0, katex: 0, reasons: {} };
const bump = (k) => { stats.reasons[k] = (stats.reasons[k] || 0) + 1; };
const imported = [];
const skipped = [];

for (const f of files) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(PARTS, f), 'utf8')); }
  catch (e) { console.error(f, 'JSON 解析失败', e.message); continue; }
  for (const lec of doc.lectures || []) {
    for (const q of lec.questions || []) {
      stats.raw++;
      if (q.skip) { stats.skipped++; bump('子代理标记跳过'); skipped.push({ file: f, lecture: lec.lecture, no: q.no, reason: q.reason || '' }); continue; }
      const statement = String(q.statement || '').trim();
      const answer = String(q.answer || '').trim();
      let solution = String(q.solution || '').trim();
      if (!solution && answer) solution = '答案：' + answer;
      if (statement.length < 20 || (!answer && solution.length < 10)) {
        stats.skipped++; bump('题干/解析过短');
        skipped.push({ file: f, lecture: lec.lecture, no: q.no, reason: 'empty' });
        continue;
      }
      const tagInfo = tax.normalize(q.tags || [], q.mainTag);
      const p = {
        code: '',
        title: String(q.title || '').trim().slice(0, 120) || ('竞赛教程 · ' + lec.title + ' · ' + q.no),
        statement,
        mainTag: tagInfo.mainTag,
        tags: tagInfo.tags,
        examTags: [],
        kind: /证明|证：|求证/.test(statement) ? '证明题' : '解答题',
        thinking: clamp(q.thinking, 1, 10, 7),
        difficulty: clamp(q.difficulty, 1, 15, 7),
        calc: clamp(q.calc, 1, 10, 5),
        source: typeof lec.lecture === 'number'
          ? '大学数学竞赛教程（吴洁）· 第' + lec.lecture + '讲 ' + lec.title + ' · 精选备赛练习'
          : '大学数学竞赛教程（吴洁）· 附录 · ' + lec.title,
        hints: [],
        answer,
        solution,
        status: 'approved',
        authorId: null,
        authorName: '竞赛教程',
        rejectReason: '',
        createdAt: new Date().toISOString(),
        reviewedAt: new Date().toISOString(),
        reviewerName: '批量导入',
        solvedCount: 0,
        attemptCount: 0,
        scoreSum: 0,
        scoreCount: 0,
        importSource: 'contest-book-2026',
        bookNo: q.no
      };
      const dup = findDup(p);
      if (dup) {
        stats.duplicate++; bump('与题库重复');
        skipped.push({ file: f, lecture: lec.lecture, no: q.no, reason: 'duplicate', dup });
        continue;
      }
      const kcheck = katexOk(p);
      if (!kcheck.ok) {
        stats.katex++; bump('KaTeX 渲染失败');
        skipped.push({ file: f, lecture: lec.lecture, no: q.no, reason: 'katex', detail: kcheck });
        continue;
      }
      p.code = allocCode();
      imported.push(p);
      seen.set(p.code, { code: p.code, title: p.title, canon: canon(p.statement), grams: null });
      stats.imported++;
    }
  }
}

const byLecture = {};
for (const p of imported) {
  const m = p.source.match(/第(\d+)讲/);
  const k = m ? m[1] : '?';
  byLecture[k] = (byLecture[k] || 0) + 1;
}
console.log(JSON.stringify({ ...stats, byLecture }, null, 2));
console.log('\n导入示例：');
for (const p of imported.slice(0, 10)) console.log(' ', p.code, 'L' + (p.source.match(/第(\d+)讲/) || [])[1], p.mainTag, p.tags.join('/'), p.title);
console.log('\n跳过示例：');
for (const s of skipped.slice(0, 10)) console.log(' ', JSON.stringify(s).slice(0, 240));

if (WRITE) {
  fs.copyFileSync(DB_FILE, DB_FILE + '.before-contest-' + Date.now() + '.json');
  db.problems.push(...imported);
  db.meta.seq = seq;
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2) + '\n', 'utf8');
  fs.writeFileSync(REPORT_FILE, JSON.stringify({ stats, byLecture, skipped, imported: imported.map((p) => ({ code: p.code, title: p.title, source: p.source, mainTag: p.mainTag, tags: p.tags })) }, null, 2) + '\n', 'utf8');
  console.log('\n已写入 ' + imported.length + ' 题，db 共 ' + db.problems.length + ' 题。');
} else {
  console.log('\n只报告，未写盘。确认后加 --write。');
}
