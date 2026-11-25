#!/usr/bin/env node
/**
 * 把「整卷塞成一道题」的真题记录拆成独立题目。
 *
 *   node tools/split-exams.mjs            # 只预览，不写盘
 *   node tools/split-exams.mjs --write    # 写入 data/batch-18.json 与 data/db.json
 *
 * 目前处理 2023 / 2025 数学一的选择、填空、解答整卷；
 * 2024 数据本身是跨记录碎片（题干缺失），不在这里机械拆。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const tax = require(path.join(ROOT, 'tag-taxonomy.js'));
const WRITE = process.argv.includes('--write');

const DB_FILE = path.join(ROOT, 'data', 'db.json');
const BATCH_FILE = path.join(ROOT, 'data', 'batch-18.json');

function trim(s) { return String(s || '').replace(/\r/g, '').trim(); }

function stripNumber(body) {
  return trim(body.replace(/^\s*\d{1,2}\s*[．.、]\s*/, ''));
}

/* 按「行首题号」切分，题号保留在 captures 里 */
function splitByLineNumber(text, pattern) {
  const t = String(text || '').replace(/\r/g, '');
  const re = new RegExp(pattern, 'gm');
  const marks = [];
  let m;
  while ((m = re.exec(t)) !== null) marks.push({ no: Number(m[1]), start: m.index, bodyStart: re.lastIndex });
  return marks.map((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : t.length;
    return { no: mark.no, body: stripNumber(t.slice(mark.start, end)) };
  });
}

/* 答案解析格式：【答案】xxx 【解析】yyy */
function splitAnswerSolution(body) {
  const t = trim(body);
  const ai = t.indexOf('【答案】');
  const pi = t.indexOf('【解析】');
  if (ai < 0 && pi < 0) return { statement: t, answer: '', solution: '' };
  const cut = [ai, pi].filter((x) => x >= 0).sort((a, b) => a - b)[0];
  const statement = trim(t.slice(0, cut));
  let answer = '';
  let solution = '';
  if (ai >= 0) {
    const end = pi > ai ? pi : t.length;
    answer = trim(t.slice(ai + 4, end).replace(/^[:：]\s*/, ''));
  }
  if (pi >= 0) solution = trim(t.slice(pi + 4).replace(/^[:：]\s*/, ''));
  return { statement, answer, solution };
}

/* 2023 选择题：第 7 题和上一题粘在同一行，不能只靠行首题号 */
function split2023Choice(text) {
  const t = String(text || '').replace(/\r/g, '');
  const markers = [
    [1, '1. 曲线'], [2, '2. 若微分方程'], [3, '3. 设函数'], [4, '4. 已知'],
    [5, '5. 已知 $n$'], [6, '6. 下列矩阵'], [7, '7. 已知向量'],
    [8, '8. 设随机变量'], [9, '9. $X _ { 1 }'], [10, '10. 设 $X _ { 1 }']
  ];
  const starts = markers.map(([no, needle]) => {
    const i = t.indexOf(needle);
    if (i < 0) throw new Error('2023 选择题找不到第 ' + no + ' 题：' + needle);
    return { no, start: i };
  });
  return starts.map((s, i) => ({
    no: s.no,
    body: stripNumber(t.slice(s.start, i + 1 < starts.length ? starts[i + 1].start : t.length))
  }));
}

/* 2025 解答题：17/18 是同一份记录，19-22 是另一份 */
function splitSolutionPart(text, numbers) {
  const t = String(text || '').replace(/\r/g, '');
  const heads = [];
  for (const no of numbers) {
    const patterns = [
      new RegExp('^\\s*' + no + '\\s*[．.]\\s*[（(]', 'm'),
      new RegExp('^\\s*' + no + '\\s*[．.]\\s*', 'm')
    ];
    let idx = -1;
    for (const re of patterns) {
      const m = re.exec(t);
      if (m) { idx = m.index; break; }
    }
    if (idx < 0 && no === numbers[0] && numbers[0] === 19) idx = 0; // 19 题题干没有题号
    if (idx < 0) throw new Error('解答题找不到第 ' + no + ' 题');
    heads.push({ no, start: idx });
  }
  heads.sort((a, b) => a.start - b.start);
  return heads.map((h, i) => {
    let body = t.slice(h.start, i + 1 < heads.length ? heads[i + 1].start : t.length);
    body = body.replace(/^\s*\d{1,2}\s*[．.]\s*(?:[（(][^）)]*[）)])?\s*/, '').trim();
    const si = body.search(/(?:^|\n)\s*(?:\d{1,2}\s*[．.]\s*)?解\s*[：:]/);
    let statement = body;
    let solution = '';
    if (si >= 0) {
      const cut = body.indexOf('解', si);
      statement = trim(body.slice(0, cut)).replace(/\s*\d{1,2}\s*[．.]\s*$/, '');
      solution = trim(body.slice(cut).replace(/^解\s*[：:]\s*/, ''));
    }
    return { no: h.no, statement, answer: '', solution };
  });
}

/* 按题干关键词判主标签，再用子标签关键词细化。比直接拿全卷标签准得多。 */
const MAIN_RULES = [
  ['微分方程', /微分方程|通解|特解|初值|伯努利|可分离变量|一阶线性|二阶常系数|欧拉方程|y\s*\^\s*\{?\s*\\prime/],
  ['级数', /级数|收敛|发散|幂级数|傅里叶|和函数|收敛半径|绝对收敛|条件收敛|正弦级数|余弦级数/],
  ['概率统计', /概率|分布|期望|方差|随机变量|估计|检验|样本|泊松|正态|二项|总体|协方差|置信/],
  ['导数与微分', /导数|可导|求导|极值|拐点|中值定理|渐近线|切线|偏导|全微分|梯度|方向导数|微分|\\prime|\\partial/],
  ['积分', /积分|\\int|原函数|二重|三重|曲线积分|曲面积分|格林|高斯|斯托克斯/],
  ['线性代数', /矩阵|行列式|向量|特征值|特征向量|二次型|线性方程组|线性表示|线性相关|线性无关|秩|可逆|相似|合同/],
  ['极限与连续', /极限|\\lim|operatorname[^\n]*l\s*i\s*m|无穷小|连续|间断|夹逼/],
  ['空间解析几何', /空间|平面|直线|曲面|球面|旋转/],
  ['综合', /[\s\S]/]
];

const SUB_RULES = {
  '极限与连续': [
    ['数列极限', /数列|递推|单调有界|夹逼|和式/],
    ['等价无穷小', /等价无穷小|无穷小/],
    ['连续与间断', /连续|间断/],
    ['渐近线', /渐近线/]
  ],
  '导数与微分': [
    ['微分中值定理', /中值定理|罗尔|拉格朗日|柯西/],
    ['泰勒展开', /泰勒|麦克劳林/],
    ['洛必达法则', /洛必达/],
    ['多元函数微分', /偏导|全微分|梯度|方向导数|多元函数|可微/],
    ['隐函数与参数方程求导', /隐函数|参数方程/],
    ['高阶导数', /高阶导数|二阶导数|莱布尼茨/],
    ['函数性态与不等式', /极值|单调|凹凸|拐点|不等式|渐近线|切线|最值|零点/],
    ['导数定义', /导数定义|可导性|不可导/]
  ],
  '积分': [
    ['曲线积分', /曲线积分|格林公式|路径无关/],
    ['曲面积分', /曲面积分|高斯公式|斯托克斯|散度|旋度/],
    ['三重积分', /三重积分|柱坐标|球坐标/],
    ['二重积分', /二重积分|累次积分|交换积分次序|\\int[^\n]*\\int/],
    ['变限积分', /变限积分|积分上限/],
    ['反常积分', /反常积分|广义积分|敛散性/],
    ['有理函数与三角积分', /有理函数|部分分式|三角有理|万能代换/],
    ['换元与分部', /分部积分|换元|凑微分/],
    ['对称性与周期性', /对称|奇偶|周期/],
    ['积分不等式', /积分不等式|积分中值/],
    ['定积分应用', /面积|体积|弧长|旋转体|形心/],
    ['不定积分', /不定积分/],
    ['定积分', /定积分|黎曼和|可积/]
  ],
  '级数': [
    ['傅里叶级数', /傅里叶|正弦级数|余弦级数/],
    ['幂级数', /幂级数|收敛半径|收敛域|和函数/],
    ['函数展开', /展开/],
    ['收敛判别', /收敛|发散|判别|比值|根值/]
  ],
  '微分方程': [
    ['一阶微分方程', /一阶|可分离|伯努利|一阶线性|齐次方程/],
    ['二阶常系数方程', /二阶|常系数|特征方程/],
    ['欧拉方程', /欧拉方程/],
    ['初值问题', /初值|定解/],
    ['可降阶方程', /可降阶|降阶/]
  ],
  '线性代数': [
    ['行列式', /行列式|代数余子式|范德蒙德/],
    ['特征值与特征向量', /特征值|特征向量/],
    ['二次型', /二次型|正定|惯性指数/],
    ['相似与对角化', /相似|对角化|Jordan/],
    ['线性方程组', /方程组|基础解系|同解/],
    ['逆矩阵与秩', /逆矩阵|伴随|矩阵的秩|秩/],
    ['向量组', /向量组|线性相关|线性表示|线性无关|向量/]
  ],
  '概率统计': [
    ['数字特征', /期望|方差|协方差|相关系数/],
    ['参数估计', /估计|似然|无偏|置信/],
    ['假设检验', /检验|显著性|两类错误/],
    ['多维随机变量', /二维|联合|边缘|条件分布/],
    ['随机变量与分布', /分布|随机变量|泊松|正态|二项|均匀/],
    ['随机事件与概率', /概率|事件|独立|条件概率/]
  ],
  '空间解析几何': [
    ['平面与直线', /平面|直线/],
    ['曲面与曲线', /曲面|曲线|球面|旋转/],
    ['向量代数', /向量|叉积|点积/],
    ['坐标变换', /坐标变换|极坐标/]
  ]
};

const CLASSIFY_OVERRIDE = {
  '2023 数学一 · 填空题第13题': { mainTag: '级数', tags: ['傅里叶级数'] },
  '2023 数学一 · 填空题第14题': { mainTag: '积分', tags: ['定积分'] },
  '2025 数学一 · 填空题第13题': { mainTag: '导数与微分', tags: ['多元函数微分'] },
  '2025 数学一 · 选择题第7题': { mainTag: '线性代数', tags: ['矩阵运算'] },
  '2025 数学一 · 解答题第20题': { mainTag: '积分', tags: ['曲面积分'] },
  '2025 数学一 · 解答题第21题': { mainTag: '线性代数', tags: ['特征值与特征向量'] }
};

function classify(text, parent) {
  const t = String(text || '');
  let main = '综合';
  for (const [name, re] of MAIN_RULES) if (re.test(t)) { main = name; break; }
  if (main === '综合' && parent && parent.mainTag) return { mainTag: parent.mainTag, tags: parent.tags };
  const key = main === '综合' ? '综合' : main;
  const rules = SUB_RULES[key] || [];
  let sub = tax.defaultSub(main);
  for (const [name, re] of rules) if (re.test(t)) { sub = name; break; }
  const r = tax.normalize([sub], main);
  return { mainTag: r.mainTag, tags: r.tags };
}

const SPLITTERS = {
  '2023 数学一 · 选择题': (p) => split2023Choice(p.statement).map((x) => ({
    title: '2023 数学一 · 选择题第' + x.no + '题',
    statement: x.body, kind: '选择题', answer: '', solution: '', no: x.no
  })),
  '2023 数学一 · 填空题': (p) => splitByLineNumber(p.statement, '^\\s*(1[1-6])\\s*[．.]\\s*').map((x) => ({
    title: '2023 数学一 · 填空题第' + x.no + '题',
    statement: x.body, kind: '填空题', answer: '', solution: '', no: x.no
  })),
  '2025 数学一 · 选择题': (p) => splitByLineNumber(p.statement, '^\\s*(\\d{1,2})\\s*．\\s*').map((x) => {
    const as = splitAnswerSolution(x.body);
    return {
      title: '2025 数学一 · 选择题第' + x.no + '题',
      statement: as.statement, kind: '选择题', answer: as.answer, solution: as.solution, no: x.no
    };
  }),
  '2025 数学一 · 填空题': (p) => splitByLineNumber(p.statement, '^\\s*(\\d{1,2})\\s*[．.]\\s*').map((x) => {
    const as = splitAnswerSolution(x.body);
    return {
      title: '2025 数学一 · 填空题第' + x.no + '题',
      statement: as.statement, kind: '填空题', answer: as.answer, solution: as.solution, no: x.no
    };
  }),
  '2025 数学一 · 解答题': (p) => (p.statement.indexOf('17．') === 0 || p.statement.indexOf('17.') === 0
    ? splitSolutionPart(p.statement, [17, 18]).map((x) => ({
      title: '2025 数学一 · 解答题第' + x.no + '题',
      statement: x.statement, kind: '解答题', answer: x.answer, solution: x.solution, no: x.no
    }))
    : splitSolutionPart(p.statement, [19, 20, 21, 22]).map((x) => ({
      title: '2025 数学一 · 解答题第' + x.no + '题',
      statement: x.statement, kind: '解答题', answer: x.answer, solution: x.solution, no: x.no
    })))
};

function buildParts(parent) {
  const splitter = SPLITTERS[parent.title];
  if (!splitter) return null;
  const raw = splitter(parent);
  if (!raw || raw.length < 2) return null;
  const total = raw.length;
  return raw.map((x, i) => {
    const cls = CLASSIFY_OVERRIDE[x.title] || classify(x.statement || '', parent);
    return {
      ...parent,
      code: '',
      title: x.title,
      statement: x.statement,
      kind: x.kind,
      mainTag: cls.mainTag,
      tags: cls.tags,
      answer: x.answer || '',
      solution: x.solution || '',
      hints: [],
      status: parent.status,
      solvedCount: 0,
      attemptCount: 0,
      scoreSum: 0,
      scoreCount: 0,
      splitFrom: parent.code || parent.title,
      part: i + 1,
      partTotal: total,
      originalNo: x.no,
      createdAt: parent.createdAt || new Date().toISOString(),
      reviewedAt: null,
      rejectReason: parent.rejectReason || ''
    };
  });
}

function report(parts, label) {
  console.log('\n' + label + ' → ' + parts.length + ' 题');
  for (const p of parts) {
    const st = String(p.statement || '').replace(/\s+/g, ' ');
    console.log('  ' + String(p.originalNo).padStart(2) + ' | ' + p.mainTag + ' | ' + p.tags.join('/')
      + ' | len=' + st.length + ' | ' + st.slice(0, 46) + ' … ' + st.slice(-36));
  }
}

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const batch = JSON.parse(fs.readFileSync(BATCH_FILE, 'utf8'));

const DB_CODES = ['HS2672', 'HS2673', 'HS2687', 'HS2688', 'HS2689', 'HS2690'];
const BATCH_TITLES = ['2023 数学一 · 选择题', '2023 数学一 · 填空题', '2025 数学一 · 选择题', '2025 数学一 · 填空题', '2025 数学一 · 解答题'];
const batchWhole = new Set(['2023 数学一 · 选择题', '2023 数学一 · 填空题', '2025 数学一 · 选择题', '2025 数学一 · 填空题']);

for (const code of DB_CODES) {
  const p = db.problems.find((x) => x.code === code);
  if (!p) { console.log('跳过不存在的 ' + code); continue; }
  const parts = buildParts(p);
  if (!parts) { console.log('未识别拆法 ' + code + ' ' + p.title); continue; }
  report(parts, code + ' ' + p.title);
}

for (let i = 0; i < batch.length; i++) {
  const p = batch[i];
  if (!BATCH_TITLES.includes(p.title)) continue;
  // 2025 解答题有两条同标题记录，都拆；2024 不处理
  const parts = buildParts({ ...p, code: '' });
  if (!parts) { console.log('批次未识别拆法 ' + i + ' ' + p.title); continue; }
  report(parts, 'batch[' + i + '] ' + p.title);
}

if (!WRITE) {
  console.log('\n只预览，未写盘。确认后加 --write。');
  process.exit(0);
}

/* ---------------- 写入 ---------------- */
let seq = Math.max(Number(db.meta && db.meta.seq) || 1001,
  ...db.problems.map((p) => Number(String(p.code || '').replace(/\D/g, '')) || 0).filter(Boolean));
const used = new Set(db.problems.map((p) => p.code));
function allocCode() {
  let code;
  do { code = 'HS' + (seq++); } while (used.has(code));
  used.add(code);
  return code;
}

const dbOut = [];
let dbReplaced = 0;
for (const p of db.problems) {
  if (!DB_CODES.includes(p.code)) { dbOut.push(p); continue; }
  const parts = buildParts(p);
  if (!parts) { dbOut.push(p); continue; }
  parts.forEach((part, i) => {
    part.code = i === 0 ? p.code : allocCode();
    part.splitFrom = p.code;
    dbOut.push(part);
  });
  dbReplaced++;
}
db.problems = dbOut;
db.meta.seq = seq;

const batchOut = [];
let batchReplaced = 0;
for (const p of batch) {
  if (!BATCH_TITLES.includes(p.title)) { batchOut.push(p); continue; }
  // 2025 解答题有 17/18 与 19-22 两份，按内容判断；两条都要拆
  if (p.title === '2025 数学一 · 解答题') {
    const parts = buildParts({ ...p, code: '' });
    if (parts) { batchOut.push(...parts); batchReplaced++; continue; }
  } else if (batchWhole.has(p.title)) {
    const parts = buildParts({ ...p, code: '' });
    if (parts) { batchOut.push(...parts); batchReplaced++; continue; }
  }
  batchOut.push(p);
}
batch.length = 0;
batch.push(...batchOut);

fs.copyFileSync(DB_FILE, path.join(path.dirname(DB_FILE), 'db.json.before-split-' + Date.now() + '.json'));
fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2) + '\n', 'utf8');
fs.writeFileSync(BATCH_FILE, JSON.stringify(batch, null, 2) + '\n', 'utf8');
console.log('\n已写入：db 替换 ' + dbReplaced + ' 条，共 ' + db.problems.length + ' 题；batch 替换 ' + batchReplaced + ' 条，共 ' + batch.length + ' 条。');
