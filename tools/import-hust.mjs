/**
 * 华科微积分真题导入：解析 Collection-of-Calculus-Exams 的 LaTeX 源。
 *
 * 目录结构：每份试卷一个 .tex，\chapter 标明「20xx-20xx学年微积分（一）（上）期中考试」，
 * 参考答案在另一个 .tex（chapter 名带「参考答案」）。题干用 enumerate + \item。
 *
 * 用法：node tools/import-hust.mjs <tex目录> <输出.json>
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2];
const OUT = process.argv[3] || 'data/batch-hust.json';
if (!DIR) { console.error('用法: node tools/import-hust.mjs <tex目录> [输出.json]'); process.exit(1); }

/* ---------- 读 chapter 块 ---------- */
function readChapters(file) {
  const src = fs.readFileSync(file, 'utf8');
  const parts = src.split(/^\\chapter\*?\{/m);
  const out = [];
  for (let i = 1; i < parts.length; i++) {
    const end = parts[i].indexOf('}');
    if (end < 0) continue;
    const title = parts[i].slice(0, end).trim();
    out.push({ title, body: parts[i].slice(end + 1) });
  }
  return out;
}

/* ---------- 从正文提取 \item ---------- */
function readItems(body) {
  const items = [];
  const re = /\\item\s+/g;
  const marks = [];
  let m;
  while ((m = re.exec(body)) !== null) marks.push(m.index + m[0].length);
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1] : body.length;
    let seg = body.slice(start, end);
    // 去掉排版用的空白预留、vspace、分页
    seg = seg.replace(/\\vspace\*?\{[^}]*\}/g, '')
      .replace(/\\newpage|\\clearpage|\\bigskip|\\medskip|\\smallskip/g, '')
      .replace(/\\begin\{enumerate\}|\\end\{enumerate\}/g, '')
      .replace(/\\begin\{itemize\}|\\end\{itemize\}/g, '')
      .trim();
    if (seg.length > 12) items.push(seg);
  }
  return items;
}

/* ---------- 章节类型 → 题型 ---------- */
function kindOf(sectionTitle) {
  if (/选择/.test(sectionTitle)) return { kind: 'choice', name: '选择题' };
  if (/填空/.test(sectionTitle)) return { kind: 'fill', name: '填空题' };
  if (/证明/.test(sectionTitle)) return { kind: 'solution', name: '证明题' };
  if (/计算/.test(sectionTitle)) return { kind: 'fill', name: '计算题' };
  return { kind: 'solution', name: '解答题' };
}

function readSections(body) {
  const parts = body.split(/\\section\*?\{/);
  const out = [];
  for (let i = 1; i < parts.length; i++) {
    const end = parts[i].indexOf('}');
    if (end < 0) continue;
    out.push({ title: parts[i].slice(0, end).trim(), body: parts[i].slice(end + 1) });
  }
  if (!out.length) out.push({ title: '', body });
  return out;
}

/* ---------- 规范化 LaTeX ---------- */
function normTex(s) {
  let t = String(s || '');
  t = t.replace(/\\vspace\*?\{[^}]*\}/g, '')
    .replace(/\\hspace\*?\{[^}]*\}/g, ' ')
    .replace(/\\begin\{minipage\}\{[^}]*\}|\\end\{minipage\}/g, '')
    .replace(/\\includegraphics(\[[^\]]*\])?\{[^}]*\}/g, '')
    .replace(/\\label\{[^}]*\}/g, '')
    .replace(/\\ref\{[^}]*\}/g, '')
    .replace(/\\item\b/g, '')          // 末尾残留的 \item
    .replace(/\\end\{enumerate\}|\\end\{itemize\}/g, '')
    .replace(/\\,|\\;|\\!/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return t.trim();
}

/* 题干里的 LaTeX 用 $ 包成行内公式：原文是裸数学，前端需要 $...$ 才渲染 */
function wrapMath(s) {
  // 已经带 $ 的不动；否则把常见数学片段包起来效果有限，这里保持原文，
  // 前端 mathify 会再处理（服务端 normalizeProblem 里有 mathify）
  return s;
}

function scoreOf(kind, text) {
  let th = kind === 'choice' ? 3 : kind === 'fill' ? 4 : 5;
  if (/证明/.test(text)) th += 2;
  if (/讨论|分类/.test(text)) th += 1;
  if (text.length > 240) th += 1;
  th = Math.max(1, Math.min(10, th));
  let df = kind === 'choice' ? 4 : kind === 'fill' ? 5 : 6;
  df += (th - 4);
  df = Math.max(1, Math.min(15, df));
  let ca = kind === 'choice' ? 3 : kind === 'fill' ? 5 : 6;
  const ops = (text.match(/\\int|\\iint|\\sum|\\lim|\\frac|\\sqrt/g) || []).length;
  ca += Math.min(3, Math.round(ops * 0.5));
  if (/证明/.test(text)) ca -= 1;
  ca = Math.max(1, Math.min(10, ca));
  return { thinking: th, difficulty: df, calc: ca };
}

function tagsOf(text) {
  const rules = [
    ['极限', [/\\lim/, /极限/, /无穷小/]],
    ['导数', [/\\frac\{\\mathrm\{d\}/, /求导/, /导数/, /y'/, /f'\(/]],
    ['微分', [/\\mathrm\{d\}y/, /全微分/, /微分/]],
    ['不定积分', [/\\int\s/, /原函数/]],
    ['定积分', [/\\int_/, /定积分/]],
    ['中值定理', [/中值定理/, /罗尔/, /拉格朗日/, /柯西中值/]],
    ['微分方程', [/微分方程/, /通解/, /特解/]],
    ['级数', [/级数/, /\\sum_\{n/, /收敛/]],
    ['多元函数', [/偏导/, /\\partial/, /二重积分/, /\\iint/, /极值/]],
    ['向量代数', [/向量/, /平面方程/, /直线方程/]],
    ['空间解析几何', [/曲面/, /旋转面/]],
    ['不等式', [/不等式/, /证明/]],
    ['应用题', [/面积/, /体积/, /弧长/]]
  ];
  const out = [];
  for (const [name, res] of rules) {
    if (res.some((r) => r.test(text))) out.push(name);
    if (out.length >= 3) break;
  }
  return out.length ? out : ['高等数学'];
}

/* ---------- 主流程 ---------- */
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.tex') && /^\d{4}/.test(f));
const papers = new Map();   // 标题 -> { sections }
const answers = new Map();  // 标题 -> { sections }

for (const f of files) {
  for (const ch of readChapters(path.join(DIR, f))) {
    const isAns = /参考答案|答案/.test(ch.title);
    const base = ch.title.replace(/参考答案|答案/g, '').trim();
    const secs = readSections(ch.body).map((s) => Object.assign({}, s, {
      items: readItems(s.body).map(normTex)
    }));
    (isAns ? answers : papers).set(base, { sections: secs, file: f });
  }
}

console.log('试卷', papers.size, '｜参考答案', answers.size);

const problems = [];
for (const [title, paper] of papers) {
  const ans = answers.get(title);
  // 答案按 section+顺序展开成一维，便于与题目一一对应
  const ansFlat = [];
  if (ans) for (const s of ans.sections) for (const it of s.items) ansFlat.push(it);
  let flatIdx = 0;

  for (const sec of paper.sections) {
    const k = kindOf(sec.title);
    for (const item of sec.items) {
      const answer = ansFlat[flatIdx] || '';
      flatIdx++;
      const text = wrapMath(item);
      if (text.length < 15) continue;
      const sc = scoreOf(k.kind, text);
      problems.push({
        title: (title.match(/20\d{2}-20\d{2}学年/) ? title.replace(/^20\d{2}-20\d{2}学年/, '') : title).slice(0, 60),
        statement: text + (answer ? '' : ''),
        tags: tagsOf(text),
        thinking: sc.thinking,
        difficulty: sc.difficulty,
        calc: sc.calc,
        source: '华中科技大学 ' + title,
        hints: [],
        answer: answer ? answer.slice(0, 600) : '',
        solution: ''
      });
    }
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(problems, null, 1), 'utf8');
console.log('写出', problems.length, '题 ->', OUT);
console.log('有答案', problems.filter((p) => p.answer).length);
const srcs = {};
for (const p of problems) srcs[p.source.replace(/华中科技大学\s*/, '').slice(0, 30)] = 1;
console.log('涉及试卷', Object.keys(srcs).length);
