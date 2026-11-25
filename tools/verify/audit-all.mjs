#!/usr/bin/env node
/**
 * 题库体检：只读，列出前端会显示异常的地方。
 *   node tools/verify/audit-all.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const ap = db.problems.filter((p) => p.status === 'approved');
const pend = db.problems.filter((p) => p.status !== 'approved');

/* 把题干里的数学段剔掉，只留普通文本（跨行公式也要正确识别，否则会误报） */
function textOnly(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === '$') {
      const end = s.indexOf('$$', i + 2);
      if (end > 0) { i = end + 2; continue; }
    }
    if (s[i] === '$') {
      let j = i + 1, closed = -1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '$') { closed = j; break; }
        j++;
      }
      if (closed > 0) { i = closed + 1; continue; }
    }
    out += s[i];
    i++;
  }
  return out;
}

const checks = {
  'HTML 表格': (p) => /<table>|<\/table>|<tr>|<td>/.test(p.statement || ''),
  'footnote': (p) => /\\footnote/.test(p.statement || ''),
  'displaylimits': (p) => /\\displaylimits/.test(p.statement || ''),
  'arabic 残留': (p) => /\\arabic/.test(p.statement || ''),
  '题干含答案': (p) => /【答案】|【解析】/.test(p.statement || ''),
  '疑似整卷': (p) => ((p.statement || '').match(/\n\s*\d{1,2}\s*[.．、]/g) || []).length >= 3,
  'tasks 残留': (p) => /\\begin\{tasks\}|\\task\b/.test(p.statement || ''),
  '文本裸命令': (p) => /\\[a-zA-Z]+/.test(textOnly(String(p.statement || ''))),
  '定界符奇数': (p) => {
    const s = String(p.statement || '');
    const dollars = (s.match(/(?<!\\)\$/g) || []).length;
    return dollars % 2 === 1;
  },
  '题干过短': (p) => String(p.statement || '').trim().length < 8
};

console.log('总题数', db.problems.length, '| 上线', ap.length, '| 待审', pend.length, '\n');
for (const [name, fn] of Object.entries(checks)) {
  const a = ap.filter(fn);
  const b = pend.filter(fn);
  console.log(`${name.padEnd(12)} 上线 ${String(a.length).padStart(4)}   待审 ${String(b.length).padStart(4)}` +
    (a.length ? '   例: ' + a.slice(0, 4).map((p) => p.code).join(',') : ''));
}

const bySrc = {};
for (const p of db.problems) {
  const k = p.source.includes('华中科技') ? '华科微积分'
    : p.source.includes('硕士研究生') ? '考研数学一'
      : '原有题库';
  bySrc[k] = bySrc[k] || { n: 0, ap: 0 };
  bySrc[k].n++;
  if (p.status === 'approved') bySrc[k].ap++;
}
console.log('\n来源分布:');
for (const [k, v] of Object.entries(bySrc)) console.log('  ', k, v.n, '（上线', v.ap + '）');
