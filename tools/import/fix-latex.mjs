#!/usr/bin/env node
/**
 * 把从 LaTeX 源码导入的题目，转成前端 KaTeX 能渲染的形式。
 *
 * 处理的毛病（都是华科那批 .tex 带过来的）：
 *  1. `\begin{tasks}...\task ...\end{tasks}` —— tasks 宏包的分栏选项，KaTeX 不认识，
 *     以前直接以源码形式显示在页面上。转成 （A）…（B）… 四行。
 *  2. `\begin{minipage}` / `\begin{figure}` / `\begin{center}` 等版式环境 —— 去掉外壳。
 *  3. `\textbf{...}` `\emph{...}` `\underline{...}` —— 转 markdown。
 *  4. `（\qquad）` 这种裸间距命令 —— 转全角空格。
 *  5. 裸在 `$` 外的数学片段（如 `\lim_{x\to0}`） —— 自动包进 `$...$`。
 *
 * 用法：
 *   node tools/import/fix-latex.mjs            # 只统计，不改
 *   node tools/import/fix-latex.mjs --apply    # 写回 data/db.json
 *   node tools/import/fix-latex.mjs --show HS3391
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const APPLY = process.argv.includes('--apply');
const SHOW = (process.argv[process.argv.indexOf('--show') + 1] || '').trim();

/* 把文本切成 [数学段, 普通段]，便于只处理普通段里的裸命令 */
function splitMath(s) {
  const out = [];
  let i = 0, buf = '';
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === '$') {
      const end = s.indexOf('$$', i + 2);
      if (end > 0) {
        if (buf) { out.push({ math: false, text: buf }); buf = ''; }
        out.push({ math: true, text: s.slice(i, end + 2) });
        i = end + 2;
        continue;
      }
    }
    if (s[i] === '$' && s[i + 1] !== '$') {
      let j = i + 1, closed = -1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '$') { closed = j; break; }
        if (s[j] === '\n' && s[j + 1] === '\n') break;
        j++;
      }
      if (closed > 0) {
        if (buf) { out.push({ math: false, text: buf }); buf = ''; }
        out.push({ math: true, text: s.slice(i, closed + 1) });
        i = closed + 1;
        continue;
      }
    }
    buf += s[i];
    i++;
  }
  if (buf) out.push({ math: false, text: buf });
  return out;
}

const LETTERS = 'ABCDEFGH';

/* 1) tasks 环境 -> （A）… 四行 */
function convertTasks(s) {
  return s.replace(/\\begin\{tasks\}(\[[^\]]*\])?(\(\d+\))?([\s\S]*?)\\end\{tasks\}/g, (_m, _opt, _col, body) => {
    const items = body.split(/\\task\b/).slice(1).map((x) => x.trim());
    if (!items.length) return '';
    return '\n\n' + items.map((t, i) => '（' + (LETTERS[i] || String(i + 1)) + '）' + t.replace(/\s*\n\s*/g, ' ')).join('\n\n') + '\n\n';
  });
}

/* 2) 版式环境去壳 / 不可显示的环境替换 */
function stripEnvs(s) {
  let t = s;
  t = t.replace(/\\begin\{figure\}[\s\S]*?\\end\{figure\}/g, '（图略）');
  t = t.replace(/\\begin\{minipage\}(\[[^\]]*\])?(\{[^}]*\})?/g, '');
  t = t.replace(/\\end\{minipage\}/g, '');
  t = t.replace(/\\begin\{center\}/g, '').replace(/\\end\{center\}/g, '');
  t = t.replace(/\\begin\{enumerate\}(\[[^\]]*\])?/g, '').replace(/\\end\{enumerate\}/g, '');
  t = t.replace(/\\begin\{itemize\}(\[[^\]]*\])?/g, '').replace(/\\end\{itemize\}/g, '');
  t = t.replace(/\\begin\{description\}(\[[^\]]*\])?/g, '').replace(/\\end\{description\}/g, '');
  t = t.replace(/\\item(\[[^\]]*\])?/g, '\n- ');
  t = t.replace(/\\caption\{([^}]*)\}/g, '（$1）');
  t = t.replace(/\\label\{[^}]*\}/g, '');
  t = t.replace(/\\vspace\*?\{[^}]*\}/g, '').replace(/\\hspace\*?\{[^}]*\}/g, ' ');
  t = t.replace(/\\[dt]frac\b/g, '\\frac');
  return t;
}

/* 3) 文本命令 -> markdown */
function convertTextCmds(s) {
  let t = s;
  // 导入时没还原的转义换行 / 制表符。
  // 只有后面不是小写字母时才当作转义符处理：LaTeX 命令全是小写开头
  // （\nabla \neq \nu \not \times \tan \textbf），而选项前的 `\nA.` 才是真的换行残留。
  t = t.replace(/\\n(?![a-z])/g, '\n').replace(/\\t(?![a-z])/g, ' ');
  // 脚注：KaTeX 不认识，转成括号注释
  t = t.replace(/\\footnote\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, '（注：$1）');
  // 列表宏包的残留
  t = t.replace(/\[\s*label\s*=\s*\([^)]*\)\s*\]/g, '');
  t = t.replace(/\\arabic\*?/g, '');
  t = t.replace(/\\displaylimits/g, '\\limits');
  const bold = (x) => '**' + x.replace(/\*\*/g, '') + '**';
  t = t.replace(/\\textbf\{([^{}]*)\}/g, (_m, x) => bold(x));
  t = t.replace(/\\textit\{([^{}]*)\}/g, (_m, x) => '*' + x + '*');
  t = t.replace(/\\emph\{([^{}]*)\}/g, (_m, x) => '*' + x + '*');
  t = t.replace(/\\underline\{([^{}]*)\}/g, (_m, x) => '__' + x + '__');
  t = t.replace(/\\text\{([^{}]*)\}/g, '$1');
  // （\qquad）/ (\quad) 这种填空括号
  t = t.replace(/[（(]\s*(?:\\qquad|\\quad|\\hspace\*?\{[^}]*\}|\\,|\\;|\s)+\s*[）)]/g, '（　　　　）');
  t = t.replace(/\\qquad|\\quad/g, '　');
  t = t.replace(/\\hfill|\\newline|\\par\b/g, ' ');
  t = t.replace(/\\,|\\;|\\!|\\ /g, ' ');
  return t;
}

const ALLOW = /[A-Za-z0-9 \t+\-*/=<>()|.,'\[\]{}^_!:]/;

/* 5) 普通段里的裸数学包成 $...$ */
function wrapBareMath(text) {
  const TOKEN = /\\(?:[a-zA-Z]+|[{}%&#_$])|\^\{|\_\{/;
  let out = '';
  let cursor = 0;          // 已经输出到的位置，防止左扩张回溯导致重复
  let i = 0;
  while (i < text.length) {
    const m = TOKEN.exec(text.slice(i));
    if (!m) break;
    const start = i + m.index;
    let left = start;
    while (left > cursor && ALLOW.test(text[left - 1])) left--;
    let right = start + m[0].length;
    while (right < text.length && ALLOW.test(text[right]) &&
      !(text[right] === '\\' && /^\\(?:begin|end|item|task)/.test(text.slice(right)))) right++;
    let chunk = text.slice(left, right);
    const trimmed = chunk.replace(/\s+$/, '');
    // 表格行（含 |）不包数学；没有真正数学记号也不包；
    // 只有 \n/\t 这种转义残留（选项 A. B. 那行）也不算数学
    const bare = trimmed.replace(/\\[nt]/g, '');
    if (chunk.includes('|') || !/[\\^_{]/.test(bare) || /^[A-D][.．、]/.test(trimmed)) {
      i = start + m[0].length;
      continue;
    }
    out += text.slice(cursor, left) + '$' + trimmed + '$';
    cursor = left + trimmed.length;
    i = right;
  }
  out += text.slice(cursor);
  return out;
}

function tidy(s) {
  return String(s || '')
    .replace(/\$\$([\s\S]*?)\$\$/g, (_m, x) => '$$' + x.trim() + '$$')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* 0.4) 全局清理：这些命令 KaTeX 一律不认，出现在 $ 内外都要去掉 */
function cleanGlobal(s) {
  let t = s;
  t = t.replace(/\\footnote\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, '');
  t = t.replace(/\[\s*label\s*=\s*\([^)]*\)\s*(?:\\?\[[^\]\n]*?\\?\])?\s*\]/g, '');
  t = t.replace(/\[\s*label\s*=\s*\([^)]*\)\s*\\?\[[^\]\n]*\\?\]/g, '');
  t = t.replace(/\\arabic\*?/g, '');
  t = t.replace(/\\displaylimits/g, '\\limits');
  t = t.replace(/\\?\[0\.6em\]/g, '');
  // 纯版式命令，没有语义
  t = t.replace(/\\(?:noindent|indent|centering|bigskip|medskip|smallskip|clearpage|newpage|maketitle|tableofcontents|hrule|vrule)\b/g, '');
  t = t.replace(/\\(?:section|subsection|subsubsection)\*?\{([^{}]*)\}/g, '\n\n**$1**\n\n');
  return t;
}

/* 0.5) PDF 抽出来的 HTML 表格 -> markdown 表格（原来被塞在 $...$ 里，KaTeX 会报错） */
function htmlTables(s) {
  return s.replace(/(?:\$\s*)?(<table[\s\S]*?<\/table>)(?:\s*\$)?/gi, (_m, html) => {
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1].replace(/<[^>]*>/g, '').trim())
    ).filter((r) => r.length);
    if (!rows.length) return '';
    const head = rows[0];
    const body = rows.slice(1);
    const line = (cells) => '| ' + cells.join(' | ') + ' |';
    return '\n\n' + [line(head), '| ' + head.map(() => '---').join(' | ') + ' |', ...body.map(line)].join('\n') + '\n\n';
  });
}

/* 0) LaTeX 原生定界符 -> markdown 数学定界符。
      `\[ ... \]` 是行间公式、`\( ... \)` 是行内公式，KaTeX 的 auto-render 只认 $ 和 $$。 */
function normalizeDelims(s) {
  let t = s
    .replace(/\\\[/g, '$$').replace(/\\\]/g, '$$')
    .replace(/\\\(/g, '$').replace(/\\\)/g, '$');
  // 行间公式里残留的单个 $（原文把 $ 和 \[ 混用了），去掉以免 KaTeX 报错
  t = t.replace(/\$\$([\s\S]*?)\$\$/g, (_m, body) => '$$' + body.replace(/(?<!\\)\$/g, '') + '$$');
  return t;
}

export function fixProblemText(src) {
  let s = String(src || '');
  s = cleanGlobal(s);
  s = htmlTables(s);
  s = normalizeDelims(s);
  s = convertTasks(s);
  s = stripEnvs(s);
  const segs = splitMath(s);
  s = segs.map((seg) => {
    if (seg.math) return seg.text;
    let t = convertTextCmds(seg.text);
    t = wrapBareMath(t);
    return t;
  }).join('');
  return tidy(s);
}

/* KaTeX 认识的数学环境（在 $...$ 内部用是合法的） */
const KATEX_ENVS = new Set([
  'array', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix',
  'cases', 'aligned', 'align', 'gathered', 'split', 'smallmatrix', 'subarray'
]);

/* 检查是否还残留前端不认识的东西（文本段严格查，数学段只查环境白名单） */
export function residualIssues(s) {
  const problems = [];
  const segs = splitMath(s);
  const textOnly = segs.filter((x) => !x.math).map((x) => x.text).join('\n')
    .split('\n').filter((ln) => !/^\s*\|/.test(ln)).join('\n');   // markdown 表格行不算
  if (/\\begin\{/.test(textOnly)) problems.push('文本里有 \\begin{}');
  if (/\\[a-zA-Z]+/.test(textOnly)) problems.push('文本里有裸命令');
  for (const seg of segs) {
    if (!seg.math) continue;
    for (const m of seg.text.matchAll(/\\begin\{([^}]*)\}/g)) {
      if (!KATEX_ENVS.has(m[1].trim())) problems.push('数学段里有不支持的环境 ' + m[1]);
    }
    if (/\\end\{tasks\}|\\task\b/.test(seg.text)) problems.push('数学段里有 tasks');
  }
  return [...new Set(problems)];
}

if (process.argv[1] && process.argv[1].endsWith('fix-latex.mjs')) {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const touched = [];
  for (const p of db.problems) {
    const before = p.statement || '';
    const after = fixProblemText(before);
    if (after !== before) {
      const fixedTitle = fixProblemText(p.title || '');
      touched.push({ p, after, fixedTitle, left: residualIssues(after) });
    }
  }
  console.log('需要修改的题:', touched.length, '/', db.problems.length);
  const still = touched.filter((x) => x.left.length);
  console.log('改完仍有残留:', still.length);
  for (const x of still.slice(0, 6)) console.log('  ', x.p.code, x.left.join('；'), '|', x.after.slice(0, 80).replace(/\n/g, ' '));

  if (SHOW) {
    const t = touched.find((x) => x.p.code === SHOW);
    if (t) { console.log('--- ' + SHOW + ' 修改后 ---\n' + t.after); }
    else { const p = db.problems.find((x) => x.code === SHOW); console.log('（未变化）\n' + (p ? p.statement : 'not found')); }
  }

  if (APPLY) {
    for (const x of touched) {
      x.p.statement = x.after;
      if (x.fixedTitle) x.p.title = x.fixedTitle;
    }
    const bak = DB_FILE + '.before-latex-' + Date.now() + '.json';
    fs.copyFileSync(DB_FILE, bak);
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    console.log('已写盘', DB_FILE, '| 备份', path.basename(bak));
  }
}
