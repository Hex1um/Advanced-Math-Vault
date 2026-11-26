#!/usr/bin/env node
/**
 * 修复题库里的「控制字符」污染
 *
 *   node tools/ops/repair-control-chars.mjs                 # 只报告（默认 data/db.json）
 *   node tools/ops/repair-control-chars.mjs --file x.json --write
 *
 * 典型病例：某次导入把 `\arctan` 写成了 JS 字符串，`\a` 被当成转义序列，
 * 落库后变成 U+0007 + "rctan"，KaTeX 直接报 “Unexpected character”。
 * 同类还有 `\b`(β)、`\v`(vec)、`\f`(frac)。
 *
 * 做法：仅当控制字符后面紧跟 ASCII 字母时才还原成 `\` + 对应字母，
 * 其余控制字符只报告不乱改（避免把正常文本里的制表符/换行改坏）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const HAS = (n) => argv.includes('--' + n);
const ARG = (n, def) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};

const FILE = path.resolve(ARG('file', path.join(ROOT, 'data', 'db.json')));
const WRITE = HAS('write');

/* 控制字符 → 被吃掉的 LaTeX 命令首字母（0x09 单独处理，见 fixTabsInMath） */
const LATEX_MAP = { 0x07: 'a', 0x08: 'b', 0x0b: 'v', 0x0c: 'f' };
const FIELD_RE = /[\u0007\u0008\u000b\u000c](?=[A-Za-z])/g;

/* 制表符只在「数学环境内且紧跟字母」时才算被吃掉的 \t（\tan、\theta…）。
   正文里的缩进制表符保持原样。 */
function fixTabsInMath(text) {
  const s = String(text || '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '$') {
      const display = s[i + 1] === '$';
      const closer = display ? '$$' : '$';
      let j = i + closer.length;
      let end = -1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s.startsWith(closer, j)) { end = j; break; }
        j++;
      }
      if (end > 0) {
        out += s.slice(i, end + closer.length).replace(/\t(?=[A-Za-z])/g, '\\t');
        i = end + closer.length;
        continue;
      }
    }
    if (s[i] === '\\' && s[i + 1] === '[') {
      const end = s.indexOf('\\]', i + 2);
      if (end > 0) {
        out += s.slice(i, end + 2).replace(/\t(?=[A-Za-z])/g, '\\t');
        i = end + 2;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

if (!fs.existsSync(FILE)) {
  console.error('✗ 找不到 ' + FILE);
  process.exit(2);
}

const db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const hits = [];
let changed = 0;

function scan(value, where) {
  if (typeof value !== 'string') return value;
  FIELD_RE.lastIndex = 0;
  let next = value;
  if (FIELD_RE.test(value)) {
    next = value.replace(FIELD_RE, (m) => '\\' + LATEX_MAP[m.charCodeAt(0)]);
    hits.push({ where, before: value.slice(0, 80), after: next.slice(0, 80) });
    changed++;
  }
  const tabbed = fixTabsInMath(next);
  if (tabbed !== next) {
    hits.push({ where, before: '数学环境内的制表符 → ' + JSON.stringify(next.slice(0, 60)), after: tabbed.slice(0, 60) });
    next = tabbed;
    changed++;
  }
  // 只报告不改：其它控制字符（制表符、其它被吃掉的首字母）留给人工判断
  const others = [];
  for (const ch of next) {
    const c = ch.codePointAt(0);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) others.push('U+' + c.toString(16).padStart(4, '0'));
  }
  if (others.length) hits.push({ where, before: '(未自动修复) ' + others.join(','), after: next.slice(0, 60) });
  return next;
}

for (const p of db.problems || []) {
  for (const f of ['title', 'statement', 'answer', 'solution']) p[f] = scan(p[f], (p.code || '?') + '.' + f);
  if (Array.isArray(p.hints)) p.hints = p.hints.map((h, i) => scan(h, (p.code || '?') + '.hints[' + i + ']'));
}
for (const u of db.users || []) u.name = scan(u.name, 'user:' + (u.id || u.name));
for (const t of db.posts || []) {
  t.title = scan(t.title, 'post:' + t.id + '.title');
  t.body = scan(t.body, 'post:' + t.id + '.body');
  if (Array.isArray(t.replies)) t.replies = t.replies.map((r, i) => { r.body = scan(r.body, 'post:' + t.id + '.reply[' + i + ']'); return r; });
}
for (const f of db.feedbacks || []) scan(f.content, 'feedback:' + f.id);

console.log('文件：' + FILE);
console.log('自动修复 ' + changed + ' 处（LaTeX 命令首字母被控制字符吃掉）');
for (const h of hits) console.log('  · ' + h.where + ' | ' + h.before + ' → ' + h.after);

if (!changed) {
  console.log('没有需要修复的 LaTeX 控制字符污染');
  process.exit(0);
}
if (!WRITE) {
  console.log('\n（未写盘）加 --write 应用修复');
  process.exit(0);
}
const tmp = FILE + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
fs.renameSync(tmp, FILE);
console.log('\n✓ 已写回 ' + FILE);
