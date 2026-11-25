#!/usr/bin/env node
/**
 * 用 PDF 转写结果补全/导入华科微积分真题。
 *
 *   node tools/import-hust-pdf.mjs            # 只报告
 *   node tools/import-hust-pdf.mjs --write    # 写入 data/db.json
 *
 * 优先按「来源 + 第 N 题」匹配已有题：
 *   - 已有题没有解析 → 用 PDF 参考答案补 answer/solution
 *   - 已有题已有解析 → 只补 华科期中/华科期末 标签
 *   - 找不到的题 → 查重后作为新题导入
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const tax = require(path.join(ROOT, 'tag-taxonomy.js'));
const katex = require(path.join(ROOT, 'docs', 'vendor', 'katex', 'katex.min.js'));
const WRITE = process.argv.includes('--write');
const TMP = process.env.TEMP + '/hust-pdf';
const DB_FILE = path.join(ROOT, 'data', 'db.json');
const REPORT_FILE = path.join(ROOT, 'data', 'hust-import-report.json');

const rawExams = JSON.parse(fs.readFileSync(path.join(TMP, 'hust-raw.json'), 'utf8'));
const converted = JSON.parse(fs.readFileSync(path.join(TMP, 'hust-converted.json'), 'utf8'));
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

const EXAM_TAGS = ['华科期中', '华科期末'];
const clamp = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : def;
};

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
function sourceKey(s) {
  return String(s || '').replace(/华中科技大学/g, '').replace(/[\s（）()·\-—_]/g, '');
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

function simOf(a, b) {
  const ca = canon(a), cb = canon(b);
  if (!ca || !cb) return 0;
  if (ca.length < 12 || cb.length < 12) return ca === cb ? 1 : 0;
  return jaccard(grams(ca), grams(cb));
}

function katexSegments(text) {
  const s = String(text || '');
  const out = [];
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

let preTagged = 0;
for (const p of db.problems) {
  if (!p.source || !/华中科技大学/.test(p.source)) continue;
  const isMid = /期中/.test(p.source), isFinal = /期末/.test(p.source);
  if (!isMid && !isFinal) continue;
  const tag = isMid ? '华科期中' : '华科期末';
  if (!Array.isArray(p.examTags)) p.examTags = [];
  if (!p.examTags.includes(tag)) { p.examTags.push(tag); preTagged++; }
}

const stats = { preTagged, converted: converted.length, matched: 0, enriched: 0, tagged: 0, new: 0, skipped: 0, katex: 0, duplicate: 0, reasons: {} };
const bump = (k) => { stats.reasons[k] = (stats.reasons[k] || 0) + 1; };
const imported = [];
const skipped = [];
const enriched = [];

/* 现有华科期中/期末题：按 来源key + 第N题 建索引 */
const existingByKey = new Map();
for (const p of db.problems) {
  if (!p.source || !/华中科技大学/.test(p.source) || !/(期中|期末)/.test(p.source)) continue;
  const m = String(p.title || '').match(/第(\d+)题/);
  if (!m) continue;
  existingByKey.set(sourceKey(p.source) + '#' + Number(m[1]), p);
}

/* 现有题全量索引，给找不到同编号的题兜底查重 */
const allExisting = db.problems.map((p) => ({ p, canon: canon(p.statement), grams: null }));

let seq = Math.max(Number(db.meta && db.meta.seq) || 1001,
  ...db.problems.map((p) => Number(String(p.code || '').replace(/\D/g, '')) || 0).filter(Boolean));
const used = new Set(db.problems.map((p) => p.code));
function allocCode() {
  let code;
  do { code = 'HS' + (seq++); } while (used.has(code));
  used.add(code);
  return code;
}

function findDup(problem, threshold = 0.9) {
  const c = canon(problem.statement);
  if (!c) return null;
  const g = grams(c);
  let best = null;
  for (const x of allExisting) {
    if (!x.grams) x.grams = grams(x.canon);
    const sim = c.length < 12 || x.canon.length < 12 ? (c === x.canon ? 1 : 0) : jaccard(g, x.grams);
    if (sim >= threshold && (!best || sim > best.score)) best = { item: x.p, score: sim };
  }
  return best;
}

for (const item of converted) {
  if (item.skip) { stats.skipped++; bump('模型标记跳过'); continue; }
  const exam = rawExams[item.examIndex];
  if (!exam) { stats.skipped++; bump('找不到原卷'); continue; }
  const tag = exam.type === '期中' ? '华科期中' : '华科期末';
  const statement = String(item.statement || '').trim();
  const answer = String(item.answer || '').trim();
  const solution = String(item.solution || '').trim();
  if (statement.length < 20 || answer.length < 1 || solution.length < 30) {
    stats.skipped++; bump('题干/答案/解析过短');
    skipped.push({ no: item.no, exam: exam.title, reason: 'empty' });
    continue;
  }
  const kcheck = katexOk({ statement, answer, solution });
  if (!kcheck.ok) {
    stats.katex++; bump('KaTeX 渲染失败');
    skipped.push({ no: item.no, exam: exam.title, reason: 'katex', detail: kcheck });
    continue;
  }

  const key = sourceKey('华中科技大学 ' + exam.title) + '#' + item.no;
  let target = existingByKey.get(key) || null;

  // 同来源同题号也可能因为 PDF/旧库题号错位而配错，题干相似度太低就不认
  if (target && simOf(target.statement, statement) < 0.55) target = null;

  // 同来源同题号找不到时，用题干相似度兜底
  if (!target) {
    const dup = findDup({ statement });
    if (dup && dup.score >= 0.92) target = dup.item;
  }

  if (target) {
    stats.matched++;
    if (!Array.isArray(target.examTags)) target.examTags = [];
    if (!target.examTags.includes(tag)) { target.examTags.push(tag); stats.tagged++; }
    if (!String(target.solution || '').trim()) {
      const before = { answer: target.answer || '', solution: target.solution || '' };
      target.answer = answer;
      target.solution = solution;
      enriched.push({ code: target.code, title: target.title, before });
      stats.enriched++;
    }
    continue;
  }

  const dup = findDup({ statement });
  if (dup) {
    stats.duplicate++; bump('与题库重复');
    skipped.push({ no: item.no, exam: exam.title, reason: 'duplicate', code: dup.item.code, score: Math.round(dup.score * 100) });
    continue;
  }
  const near = findDup({ statement }, 0.6);

  const tagInfo = tax.normalize(item.tags || [], item.mainTag);
  const p = {
    code: allocCode(),
    title: String(item.title || '').trim().slice(0, 120) || ('华科微积分 · ' + exam.title.replace(/^\d{4}-\d{4}学年/, '').slice(0, 30)),
    statement,
    mainTag: tagInfo.mainTag,
    tags: tagInfo.tags,
    examTags: [tag],
    kind: String(item.kind || '').slice(0, 12),
    thinking: clamp(item.thinking, 1, 10, 6),
    difficulty: clamp(item.difficulty, 1, 15, 6),
    calc: clamp(item.calc, 1, 10, 5),
    source: '华中科技大学 ' + exam.title,
    hints: [],
    answer,
    solution,
    status: 'approved',
    authorId: null,
    authorName: '华科真题',
    rejectReason: '',
    createdAt: new Date().toISOString(),
    reviewedAt: new Date().toISOString(),
    reviewerName: 'PDF 批量导入',
    solvedCount: 0,
    attemptCount: 0,
    scoreSum: 0,
    scoreCount: 0,
    importSource: 'hust-pdf-2026',
    conversion: 'deepseek-chat'
  };
  imported.push(p);
  allExisting.push({ p, canon: canon(p.statement), grams: null });
  existingByKey.set(key, p);
  stats.new++;
}

/* 统计标签覆盖 */
const tagCounts = {};
for (const p of db.problems.concat(imported)) {
  for (const t of p.examTags || []) if (EXAM_TAGS.includes(t)) tagCounts[t] = (tagCounts[t] || 0) + 1;
}

console.log(JSON.stringify({ ...stats, tagCounts }, null, 2));
console.log('\n补解析示例：');
for (const x of enriched.slice(0, 8)) console.log(' ', x.code, x.title);
console.log('\n新导入示例：');
for (const p of imported.slice(0, 20)) console.log(' ', p.code, p.examTags[0], p.mainTag, p.tags.join('/'), p.title, p.nearExisting ? '| near ' + p.nearExisting.code + ' ' + p.nearExisting.score + '%' : '');
console.log('\n跳过示例：');
for (const x of skipped.slice(0, 10)) console.log(' ', JSON.stringify(x).slice(0, 220));

if (WRITE) {
  fs.copyFileSync(DB_FILE, DB_FILE + '.before-hust-pdf-' + Date.now() + '.json');
  db.problems.push(...imported);
  db.meta.seq = seq;
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2) + '\n', 'utf8');
  fs.writeFileSync(REPORT_FILE, JSON.stringify({ stats, tagCounts, skipped, enriched: enriched.map((x) => ({ code: x.code, title: x.title })), imported: imported.map((p) => ({ code: p.code, title: p.title, examTags: p.examTags, mainTag: p.mainTag, tags: p.tags })) }, null, 2) + '\n', 'utf8');
  console.log('\n已写入：补解析 ' + stats.enriched + '，新增 ' + stats.new + '，db 共 ' + db.problems.length + ' 题。');
} else {
  console.log('\n只报告，未写盘。确认后加 --write。');
}
