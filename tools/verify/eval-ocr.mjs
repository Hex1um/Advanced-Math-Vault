#!/usr/bin/env node
/**
 * OCR 坏例评测：把「识别原文 vs 用户改正后」的字符错误率算出来，用来量化每次改动的效果。
 *
 *   node tools/verify/eval-ocr.mjs                 # 读 data/db.json 的 ocrBadcases
 *   node tools/verify/eval-ocr.mjs --file cases.json   # 读外部 [{raw, final, conf, variant}]
 *   node tools/verify/eval-ocr.mjs --baseline data/ocr-eval-report.json  # 和上次报告比
 *
 * 指标：CER = 编辑距离 / max(len(raw), len(final))，越低越好。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

const DB = path.join(ROOT, 'data', 'db.json');
const fileArg = flag('file', '');
let cases = [];
if (fileArg) {
  cases = JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8'));
} else {
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  cases = db.ocrBadcases || [];
}
if (!cases.length) {
  console.log('还没有坏例。让用户投稿时走一遍 OCR 再手动改错，就会自动采集。');
  process.exit(0);
}

/* 去掉 [low] 标记与多余空白，只比字符 */
const norm = (s) => String(s || '')
  .replace(/\[\/?low\]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

const rows = cases.map((c) => {
  const r = norm(c.raw), f = norm(c.final);
  const dist = editDistance(r, f);
  const denom = Math.max(r.length, f.length) || 1;
  return {
    id: c.id || '',
    at: c.at || '',
    variant: c.variant || 'n/a',
    conf: Number(c.conf) || 0,
    len: f.length,
    dist,
    cer: dist / denom
  };
});

const pct = (v) => (v * 100).toFixed(1) + '%';
const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
const median = (arr) => {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

const buckets = {
  'conf<60': rows.filter((x) => x.conf > 0 && x.conf < 60),
  'conf60-80': rows.filter((x) => x.conf >= 60 && x.conf < 80),
  'conf>=80': rows.filter((x) => x.conf >= 80)
};
const byVariant = {};
for (const r of rows) (byVariant[r.variant] = byVariant[r.variant] || []).push(r);

const report = {
  generatedAt: new Date().toISOString(),
  cases: rows.length,
  meanCER: mean(rows.map((r) => r.cer)),
  medianCER: median(rows.map((r) => r.cer)),
  byConfidence: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, { n: v.length, meanCER: mean(v.map((x) => x.cer)) }])),
  byVariant: Object.fromEntries(Object.entries(byVariant).map(([k, v]) => [k, { n: v.length, meanCER: mean(v.map((x) => x.cer)) }])),
  worst: rows.slice().sort((a, b) => b.cer - a.cer).slice(0, 10)
};

console.log(`坏例 ${rows.length} 条 | 平均 CER ${pct(report.meanCER)} | 中位数 ${pct(report.medianCER)}`);
console.log('按置信度分档：');
for (const [k, v] of Object.entries(report.byConfidence)) console.log(`  ${k.padEnd(10)} n=${String(v.n).padStart(3)}  CER ${pct(v.meanCER)}`);
console.log('按预处理版本：');
for (const [k, v] of Object.entries(report.byVariant)) console.log(`  ${k.padEnd(10)} n=${String(v.n).padStart(3)}  CER ${pct(v.meanCER)}`);
console.log('最差 5 条：');
report.worst.slice(0, 5).forEach((w) => console.log(`  ${w.id || '-'} ${w.variant} conf=${w.conf} dist=${w.dist}/${w.len} CER=${pct(w.cer)}`));

const baseline = flag('baseline', '');
if (baseline && fs.existsSync(baseline)) {
  const old = JSON.parse(fs.readFileSync(baseline, 'utf8'));
  const delta = report.meanCER - old.meanCER;
  console.log(`\n对比基线（${old.generatedAt}，${old.cases} 条）：${pct(old.meanCER)} → ${pct(report.meanCER)}  ` +
    (delta < 0 ? `↓ 改善 ${pct(-delta)}` : delta > 0 ? `↑ 变差 ${pct(delta)}` : '持平'));
}

const out = path.join(ROOT, 'data', 'ocr-eval-report.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
console.log('\n报告已写入 data/ocr-eval-report.json');
