#!/usr/bin/env node
/**
 * 零依赖 lint 门禁（只做几条「机械可判、误报率接近零」的规则）
 *
 *   node tools/verify/lint.mjs          # 检查
 *   node tools/verify/lint.mjs --list   # 只列文件，不检查
 *
 * 为什么不用 ESLint：
 *   这个仓库的 CI 刻意保持「不装任何依赖」（checkout → node → 直接跑），
 *   引入 ESLint 就要 npm ci + 依赖树，与「零依赖、clone 即跑」的定位冲突。
 *   但这不代表不需要门禁——下面几条规则覆盖了历史 review 里真实出现过的问题：
 *
 *   1. no-var             —— 函数作用域变量在闭包里最容易出「改了一处、另一处跟着变」
 *   2. eqeqeq（放行 == null）—— 漏写 = 是最常见的笔误；`== null` 是唯一有意为之的宽松比较
 *   3. syntax             —— 每个交付文件都用 node --check 过一遍（public/js 不在测试里跑，
 *                            以前出现过语法错只到浏览器才炸）
 *
 * 实现上先做词法过滤（注释 / 字符串 / 正则 / 模板串都抹成空格并保留换行），
 * 再在「纯代码」上匹配。不这么做的话 base64 串里的 `==`、注释里的 `var` 全是误报。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

/* 扫描范围：线上真正跑的代码 + 测试脚本。tools/archive 这类一次性脚本不在其中。 */
const TARGETS = [
  'server.js',
  'tag-taxonomy.js',
  'lib',
  'routes',
  'public/js',
  'tools/verify',
  'tools/ops',
  'tools/import'
];

function walk(p) {
  const abs = path.join(ROOT, p);
  if (!fs.existsSync(abs)) return [];
  const st = fs.statSync(abs);
  if (st.isFile()) return /\.(js|mjs)$/.test(p) ? [abs] : [];
  const out = [];
  for (const name of fs.readdirSync(abs)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    out.push(...walk(path.join(p, name)));
  }
  return out;
}

/**
 * 把注释 / 字符串 / 正则 / 模板串替换成等长空格（换行保留），
 * 这样行号列号仍然准确，匹配只落在真正的代码上。
 */
function blankNonCode(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  let prevSignificant = '';        // 上一个非空白代码字符，用来判断 `/` 是除号还是正则
  const KEYWORDS_BEFORE_REGEX = /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        if (src[j] === '\n') break;    // 未闭合的字符串：到行尾为止，别吞掉整份文件
        j++;
      }
      blank(i + 1, j - 1 > i ? j - 1 : i + 1);
      i = j;
      prevSignificant = c;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (depth === 0 && src[j] === '`') { j++; break; }
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0 && src[j] === '}') { depth--; j++; continue; }
        j++;
      }
      /* 模板串里的 ${} 表达式其实是代码，这里为了简单一并抹掉：
         宁可漏报（模板里写 var 极少见），也不要误报。 */
      blank(i + 1, j - 1 > i ? j - 1 : i + 1);
      i = j;
      prevSignificant = c;
      continue;
    }
    if (c === '/') {
      const before = src.slice(Math.max(0, i - 24), i);
      const isRegex = prevSignificant === '' || /[=(,:;[!&|?{};+\-*%<>~^]$/.test(prevSignificant)
        || KEYWORDS_BEFORE_REGEX.test(before);
      if (isRegex) {
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) { j++; break; }
          else if (src[j] === '\n') break;   // 不是正则，收回
          j++;
        }
        blank(i + 1, j - 1 > i ? j - 1 : i + 1);
        i = j;
        prevSignificant = '/';
        continue;
      }
    }
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out.join('');
}

const RULES = [
  {
    id: 'no-var',
    pattern: /\bvar\s+[A-Za-z_$]/g,
    hint: '用 const / let 代替 var（函数作用域变量在闭包里容易被意外改写）'
  },
  {
    id: 'eqeqeq',
    /* `===` / `!==` / `== null` / `!= null` 都不算违规 */
    pattern: /(?:[^=!<>]==(?!=[^=]|\s*null\b))|(?:[^=!]!=(?!=|\s*null\b))/g,
    hint: '用 === / !==（只有 == null 是允许的宽松比较）'
  }
];

function lineCol(src, index) {
  const before = src.slice(0, index);
  const line = before.split('\n').length;
  const col = index - before.lastIndexOf('\n');
  return { line, col };
}

const files = [...new Set(TARGETS.flatMap(walk))].sort();

if (process.argv.includes('--list')) {
  for (const f of files) console.log(path.relative(ROOT, f));
  process.exit(0);
}

let violations = 0;
let syntaxErrors = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const src = fs.readFileSync(file, 'utf8');

  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    syntaxErrors++;
    const msg = String((e.stderr && e.stderr.toString()) || (e && e.message) || '').trim().split('\n').slice(0, 4).join('\n    ');
    console.error('✗ ' + rel + ' 语法错误:\n    ' + msg);
  }

  const code = blankNonCode(src);
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m;
    while ((m = rule.pattern.exec(code)) !== null) {
      /* eqeqeq 的匹配会把前后各一个字符带进来，定位时取真正的位置 */
      const at = m[0].indexOf('==') >= 0 ? m.index + m[0].indexOf('==')
        : m[0].indexOf('!=') >= 0 ? m.index + m[0].indexOf('!=')
          : m.index;
      const { line, col } = lineCol(code, at);
      violations++;
      const snippet = src.split('\n')[line - 1].trim().slice(0, 100);
      console.error('✗ ' + rel + ':' + line + ':' + col + '  [' + rule.id + '] ' + rule.hint + '\n    ' + snippet);
    }
  }
}

console.log('\n扫描 ' + files.length + ' 个文件：' + violations + ' 处规则违规，' + syntaxErrors + ' 处语法错误');
process.exit(violations + syntaxErrors ? 1 : 0);
