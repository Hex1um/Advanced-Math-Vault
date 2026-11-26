#!/usr/bin/env node
/**
 * 生成「华科微积分（B）2026」科目包：章节与考点手工定义，题目从题库按考点抽取。
 *
 *   node tools/import/build-calculus-pack.mjs            # 只报告覆盖率
 *   node tools/import/build-calculus-pack.mjs --write    # 写 data/subjects/hust-calculus-b-2026.json
 *
 * 为什么用生成而不是手写：微积分真题已经在题库里（754 道华科卷），
 * 手抄一遍既浪费又会与题库失同步。这里只维护「章节 → 考点 → 标签」的映射，
 * 题目用 ref 引用题库编号，题库更新后重跑即可。
 *
 * 选题优先级：微积分（B）> 微积分（一）> 其他华科卷；同优先级按题目编号。
 * 每个考点最多 MAX_PER_POINT 道，避免科目包体积失控（引用型题目在加载时才解析）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const OUT = path.join(ROOT, 'data', 'subjects', 'hust-calculus-b-2026.json');
const WRITE = process.argv.includes('--write');
const MAX_PER_POINT = Number(process.env.MAX_PER_POINT || 10);

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const problems = (db.problems || []).filter((p) => p.status === 'approved');

/* 章节 / 考点：tags 里的任一命中即归入该考点，mainTag 必须一致 */
const CHAPTERS = [
  {
    id: 'c1', no: '第一章', title: '函数、极限与连续', weight: 5,
    summary: '极限计算与连续性判定是整张卷子的地基，期末必考。',
    points: [
      { id: 'p1-1', title: '函数极限的计算', main: '极限与连续', tags: ['函数极限'], core: '先判型（0/0、∞/∞、1^∞、∞-∞），再选法：等价无穷小、洛必达、泰勒、夹逼。', keys: ['等价无穷小', '洛必达', '泰勒'], examTypes: ['fill', 'calc'] },
      { id: 'p1-2', title: '数列极限与单调有界', main: '极限与连续', tags: ['数列极限', '夹逼与单调有界'], core: '数列极限优先用单调有界准则与夹逼；递推数列先证有界再证单调。', keys: ['单调有界', '夹逼', '递推'], examTypes: ['calc', 'proof'] },
      { id: 'p1-3', title: '无穷小的比较', main: '极限与连续', tags: ['等价无穷小'], core: '记住常用等价：sin x~x、1-cos x~x²/2、ln(1+x)~x、e^x-1~x、(1+x)^a-1~ax。', keys: ['等价无穷小', '阶'], examTypes: ['fill'] },
      { id: 'p1-4', title: '连续与间断点', main: '极限与连续', tags: ['连续与间断'], core: '先看左右极限是否相等，再分类：可去、跳跃、无穷、振荡。', keys: ['左右极限', '间断点分类'], examTypes: ['fill', 'calc'] }
    ]
  },
  {
    id: 'c2', no: '第二章', title: '导数与微分', weight: 5,
    summary: '求导是送分题，也是后面所有大题的工具，必须零失误。',
    points: [
      { id: 'p2-1', title: '导数定义与可导性', main: '导数与微分', tags: ['导数定义'], core: '用定义判可导要算左右导数；分段点、绝对值点、含 |x-a| 的点必查。', keys: ['左右导数', '分段点'], examTypes: ['calc', 'proof'] },
      { id: 'p2-2', title: '复合函数与高阶求导', main: '导数与微分', tags: ['求导法则', '高阶导数'], core: '链式法则一层层剥；高阶导先找规律或用莱布尼茨公式。', keys: ['链式法则', '莱布尼茨公式'], examTypes: ['fill', 'calc'] },
      { id: 'p2-3', title: '隐函数与参数方程求导', main: '导数与微分', tags: ['隐函数与参数方程求导'], core: '隐函数两边对 x 求导后解 y′；参数方程 dy/dx=(dy/dt)/(dx/dt)。', keys: ['隐函数', '参数方程', '二阶导'], examTypes: ['calc'] },
      { id: 'p2-4', title: '微分与近似', main: '导数与微分', tags: ['求导法则'], core: 'dy=f′(x)dx；近似计算 f(x0+Δx)≈f(x0)+f′(x0)Δx。', keys: ['微分', '线性近似'], examTypes: ['fill'] }
    ]
  },
  {
    id: 'c3', no: '第三章', title: '微分中值定理与导数应用', weight: 6,
    summary: '证明题的主战场：中值定理、泰勒、不等式。',
    points: [
      { id: 'p3-1', title: '中值定理与辅助函数', main: '导数与微分', tags: ['微分中值定理'], core: '见到「存在 ξ 使 f′(ξ)=…」先想罗尔：把结论变形为 F′(ξ)=0，再构造 F。', keys: ['罗尔', '拉格朗日', '柯西', '辅助函数'], examTypes: ['proof'] },
      { id: 'p3-2', title: '泰勒展开与估值', main: '导数与微分', tags: ['泰勒展开'], core: '选展开点（端点、中点、极值点）与阶数，余项用来估界。', keys: ['泰勒', '拉格朗日余项', '展开点'], examTypes: ['proof', 'calc'] },
      { id: 'p3-3', title: '函数性态与不等式', main: '导数与微分', tags: ['函数性态与不等式'], core: '证不等式：移项构造函数、求导判单调、找最值；含双变量先固定一个。', keys: ['单调性', '最值', '构造'], examTypes: ['proof', 'calc'] },
      { id: 'p3-4', title: '洛必达法则的适用条件', main: '导数与微分', tags: ['洛必达法则'], core: '只有 0/0、∞/∞ 才能直接用；用前必须验证分子分母可导且分母导数不为零。', keys: ['洛必达', '未定式'], examTypes: ['fill', 'calc'] }
    ]
  },
  {
    id: 'c4', no: '第四章', title: '不定积分', weight: 5,
    summary: '换元与分部是两条主线，认出模式比算得快更重要。',
    points: [
      { id: 'p4-1', title: '基本积分与凑微分', main: '积分', tags: ['不定积分'], core: '先凑微分把被积式变成 f(u)du，再套基本积分表。', keys: ['凑微分', '基本积分表'], examTypes: ['fill', 'calc'] },
      { id: 'p4-2', title: '换元与分部', main: '积分', tags: ['换元与分部'], core: '含根式用三角/根式换元；含 x^n·e^x、x^n·sin x、ln x 用分部。', keys: ['三角换元', '分部积分'], examTypes: ['calc'] },
      { id: 'p4-3', title: '有理函数与三角有理式', main: '积分', tags: ['有理函数与三角积分'], core: '有理函数先做部分分式；三角有理式用万能代换或配对技巧。', keys: ['部分分式', '万能代换'], examTypes: ['calc'] }
    ]
  },
  {
    id: 'c5', no: '第五章', title: '定积分及其应用', weight: 6,
    summary: '变限积分求导、对称性、反常积分是期末必考三件套。',
    points: [
      { id: 'p5-1', title: '定积分的计算与性质', main: '积分', tags: ['定积分'], core: '牛顿-莱布尼茨公式是主干；分段函数、绝对值要拆区间。', keys: ['牛顿-莱布尼茨', '分段'], examTypes: ['fill', 'calc'] },
      { id: 'p5-2', title: '变限积分求导', main: '积分', tags: ['变限积分'], core: 'd/dx ∫[a(x),b(x)] f = f(b)b′ - f(a)a′；被积函数含 x 时先把 x 提到积分号外。', keys: ['变限积分', '求导'], examTypes: ['calc', 'proof'] },
      { id: 'p5-3', title: '对称性与周期性', main: '积分', tags: ['对称性与周期性'], core: '奇函数在对称区间积分为 0；周期函数整周期积分相等。', keys: ['奇偶性', '周期'], examTypes: ['fill', 'calc'] },
      { id: 'p5-4', title: '反常积分敛散性', main: '积分', tags: ['反常积分'], core: '与 p 积分比较：∫1/x^p 在无穷区间 p>1 收敛，在 0 附近 p<1 收敛。', keys: ['p 积分', '比较判别'], examTypes: ['fill', 'calc'] },
      { id: 'p5-5', title: '定积分的应用', main: '积分', tags: ['定积分应用'], core: '面积、体积、弧长、平均值套公式前先画图定积分限。', keys: ['面积', '旋转体体积', '平均值'], examTypes: ['calc'] }
    ]
  },
  {
    id: 'c6', no: '第六章', title: '向量代数与空间解析几何', weight: 3,
    summary: '公式密集但套路固定，属于必拿分章节。',
    points: [
      { id: 'p6-1', title: '向量运算与位置关系', main: '空间解析几何', tags: ['向量代数'], core: '点积判垂直、叉积判平行与求面积、混合积判共面。', keys: ['点积', '叉积', '混合积'], examTypes: ['fill', 'calc'] },
      { id: 'p6-2', title: '平面与直线方程', main: '空间解析几何', tags: ['平面与直线'], core: '平面用点法式，直线用点向式；夹角用方向向量与法向量。', keys: ['点法式', '点向式', '夹角'], examTypes: ['calc'] },
      { id: 'p6-3', title: '曲面与曲线', main: '空间解析几何', tags: ['曲面与曲线'], core: '旋转曲面、柱面、锥面的方程要能从图形反推。', keys: ['旋转曲面', '柱面', '锥面'], examTypes: ['fill', 'calc'] }
    ]
  },
  {
    id: 'c7', no: '第七章', title: '多元函数微分学', weight: 5,
    summary: '偏导、全微分、复合与隐函数求导，以及条件极值。',
    points: [
      { id: 'p7-1', title: '偏导数与全微分', main: '导数与微分', tags: ['多元函数微分'], core: '可微必连续、偏导存在不一定可微；全微分 dz=f_x dx+f_y dy。', keys: ['偏导', '全微分', '可微'], examTypes: ['fill', 'calc'] },
      { id: 'p7-2', title: '多元复合与隐函数求导', main: '导数与微分', tags: ['多元函数微分', '隐函数与参数方程求导'], core: '画变量依赖树，链式相加；隐函数用 F_x/F_y 公式。', keys: ['链式法则', '隐函数'], examTypes: ['calc'] },
      { id: 'p7-3', title: '极值与条件极值', main: '导数与微分', tags: ['多元函数微分'], core: '无条件极值用 AC-B² 判别；条件极值用拉格朗日乘数法。', keys: ['拉格朗日乘数', '判别式'], examTypes: ['calc'] }
    ]
  },
  {
    id: 'c8', no: '第八章', title: '重积分', weight: 5,
    summary: '二重积分换序与极坐标是高频计算题。',
    points: [
      { id: 'p8-1', title: '二重积分的计算', main: '积分', tags: ['二重积分'], core: '先画区域再定序；圆域、扇形优先极坐标，注意雅可比 r。', keys: ['换序', '极坐标', '对称性'], examTypes: ['calc'] },
      { id: 'p8-2', title: '三重积分', main: '积分', tags: ['三重积分'], core: '投影法/截面法二选一；柱面、球面对称时用柱坐标、球坐标。', keys: ['柱坐标', '球坐标', '投影法'], examTypes: ['calc'] }
    ]
  },
  {
    id: 'c9', no: '第九章', title: '曲线积分与曲面积分', weight: 4,
    summary: '格林公式把曲线积分变成二重积分，是最大的化简手段。',
    points: [
      { id: 'p9-1', title: '曲线积分', main: '积分', tags: ['曲线积分'], core: '第一类看弧长、第二类看方向；封闭曲线优先格林公式。', keys: ['格林公式', '路径无关'], examTypes: ['calc'] },
      { id: 'p9-2', title: '曲面积分', main: '积分', tags: ['曲面积分'], core: '第一类投到坐标面，第二类注意法向；封闭曲面用高斯公式。', keys: ['高斯公式', '法向'], examTypes: ['calc'] }
    ]
  },
  {
    id: 'c10', no: '第十章', title: '无穷级数', weight: 4,
    summary: '判敛与幂级数展开，套路化程度高。',
    points: [
      { id: 'p10-1', title: '数项级数判敛', main: '级数', tags: ['数项级数', '收敛判别'], core: '先看通项是否趋于 0；正项级数用比值/根值/比较，交错级数用莱布尼茨。', keys: ['比值判别', '莱布尼茨', '绝对收敛'], examTypes: ['fill', 'calc'] },
      { id: 'p10-2', title: '幂级数与展开', main: '级数', tags: ['幂级数', '函数展开'], core: '先求收敛半径，再逐项求导/积分求和函数；展开套 e^x、sin x、1/(1-x) 基本式。', keys: ['收敛半径', '逐项求导', '和函数'], examTypes: ['calc'] }
    ]
  },
  {
    id: 'c11', no: '第十一章', title: '微分方程', weight: 3,
    summary: '认类型选解法，最后别忘代初值。',
    points: [
      { id: 'p11-1', title: '一阶微分方程', main: '微分方程', tags: ['一阶微分方程'], core: '可分离先分离；一阶线性用公式 y=e^{-∫P}(∫Qe^{∫P}dx+C)。', keys: ['可分离', '一阶线性', '常数变易'], examTypes: ['calc'] },
      { id: 'p11-2', title: '二阶常系数线性方程', main: '微分方程', tags: ['二阶常系数方程'], core: '先解特征方程，再按右端项形式设特解；共振时乘 x。', keys: ['特征方程', '特解', '共振'], examTypes: ['calc'] }
    ]
  },
  {
    id: 'c12', no: '综合', title: '综合与压轴', weight: 4,
    summary: '跨章节综合题，多为证明或含参讨论。',
    points: [
      { id: 'p12-1', title: '综合应用与证明', main: '综合', tags: ['综合应用'], core: '先把条件翻译成数学语言，再找已证结论作为桥梁。', keys: ['转化', '构造'], examTypes: ['proof', 'calc'] }
    ]
  }
];

function sourceRank(p) {
  const s = String(p.source || '');
  if (/微积分（B）/.test(s)) return 0;
  if (/微积分（一）/.test(s)) return 1;
  return 2;
}

/* 题库里华科真题的子标签只有十几种（导数与微分|求导法则 就占了 231 道），
   按精确子标签匹配会让一半考点没有题。所以分两档：
     1) 精确命中该考点的子标签；
     2) 不足 3 道时，用同一主标签下的真题补位（仍是真题，只是可能覆盖相邻考点）。
   补位按考点 id 做确定性偏移，避免每个考点都拿到同一批题。 */
function hashOffset(s, n) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
  return n ? h % n : 0;
}

function pickForPoint(point) {
  const hust = problems.filter((p) => /华中科技大学/.test(String(p.source || '')));
  const sortBy = (a, b) => sourceRank(a) - sourceRank(b) || String(a.code).localeCompare(String(b.code));

  const exact = hust.filter((p) => {
    if (String(p.mainTag || '') !== point.main) return false;
    const tags = Array.isArray(p.tags) ? p.tags : [];
    return point.tags.some((t) => tags.includes(t));
  }).sort(sortBy);

  const picked = exact.slice(0, MAX_PER_POINT);
  if (picked.length >= 3) return { picked: picked, exact: picked.length, fallback: 0 };

  const have = new Set(picked.map((p) => p.code));
  const pool = hust
    .filter((p) => String(p.mainTag || '') === point.main && !have.has(p.code))
    .sort(sortBy);
  const need = Math.min(4, 6 - picked.length);
  const start = hashOffset(point.id, Math.max(1, pool.length));
  const extra = [];
  for (let i = 0; i < pool.length && extra.length < need; i++) {
    extra.push(pool[(start + i) % pool.length]);
  }
  return { picked: picked.concat(extra), exact: picked.length, fallback: extra.length };
}

const chapters = [];
const points = [];
/* 同一道真题可能同时挂在多个考点下（补位时尤其常见）：
   按题目编号合并，points 取并集，避免 id 重复导致整个包校验失败。 */
const questionMap = new Map();
const report = [];

for (const ch of CHAPTERS) {
  chapters.push({ id: ch.id, no: ch.no, title: ch.title, weight: ch.weight, summary: ch.summary });
  for (const pt of ch.points) {
    points.push({
      id: pt.id,
      chapter: ch.id,
      title: pt.title,
      core: pt.core,
      detail: pt.detail || '',
      keys: pt.keys,
      examTypes: pt.examTypes,
      frequency: pt.frequency || 4,
      traps: pt.traps || [],
      related: []
    });
    const got = pickForPoint(pt);
    const picked = got.picked;
    report.push({ point: pt.id + ' ' + pt.title, count: picked.length, exact: got.exact, fallback: got.fallback });
    for (const p of picked) {
      const exists = questionMap.get(p.code);
      if (exists) {
        if (exists.points.indexOf(pt.id) < 0) exists.points.push(pt.id);
        continue;
      }
      /* 题库里的真题把选项写进了题干，答案又是 A-D 单字母：
         这类题可以按选择题自动判分，比一律归为「计算题」体验好。 */
      const kindText = String(p.kind || '') + ' ' + String(p.title || '');
      const isChoice = /选择题/.test(kindText) && /^[A-D]$/i.test(String(p.answer || '').trim());
      const type = isChoice ? 'single'
        : (/证明/.test(kindText) ? 'proof' : (/填空/.test(kindText) ? 'fill' : 'calc'));
      questionMap.set(p.code, {
        id: 'q-' + p.code,
        type: type,
        chapter: ch.id,
        points: [pt.id],
        ref: p.code,
        source: p.source,
        difficulty: Math.max(1, Math.min(5, Math.round((Number(p.difficulty) || 6) / 3)))
      });
    }
  }
}
const questions = [...questionMap.values()];

const pack = {
  id: 'hust-calculus-b-2026',
  school: '华中科技大学',
  schoolShort: '华科',
  subject: '微积分（B）',
  subjectShort: '微积分B',
  year: '2026',
  term: '秋季学期',
  updatedAt: new Date().toISOString().slice(0, 10),
  intro: '按微积分（B）上下册章节拆分考点，题目全部来自题库里的华科历年期中/期末真题（含微积分一与 B 卷），找类似题即命中真题。',
  exam: {
    durationMin: 120,
    totalPoints: 100,
    sections: [
      { type: 'fill', name: '填空题', count: 5, per: 4, points: 20, note: '极限、导数、积分各一题' },
      { type: 'calc', name: '计算题', count: 5, per: 8, points: 40, note: '积分、重积分、级数、微分方程' },
      { type: 'calc', name: '综合题', count: 2, per: 10, points: 20, note: '跨章节' },
      { type: 'proof', name: '证明题', count: 2, per: 10, points: 20, note: '中值定理、不等式' }
    ]
  },
  sources: [
    { kind: '真题', title: '华中科技大学 微积分（一）/（B）历年期中期末卷', note: '题库内 754 道，含 2024–2026 学年 B 卷' },
    { kind: '教材', title: '《高等数学》（同济版）上下册', note: '章节顺序与 B 班教学大纲对齐' }
  ],
  chapters,
  points,
  questions
};

const missing = report.filter((r) => r.count === 0);
const exactTotal = report.reduce((s, r) => s + r.exact, 0);
const fallbackTotal = report.reduce((s, r) => s + r.fallback, 0);
console.log('考点 ' + report.length + ' 个 → 挂题 ' + questions.length + ' 道'
  + '（精确命中 ' + exactTotal + '，同章补位 ' + fallbackTotal + '）');
console.log('零命中考点 ' + missing.length + (missing.length ? '：' + missing.map((m) => m.point).join('、') : ''));
report.sort((a, b) => b.count - a.count).slice(0, 6)
  .forEach((r) => console.log('  ' + r.point + ' → ' + r.count + ' 题'));

if (!WRITE) {
  console.log('\n未写盘（加 --write 生成科目包）。');
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(pack, null, 2), 'utf8');
  console.log('\n已写入 ' + path.relative(ROOT, OUT) + '（' + questions.length + ' 道引用题）');
}
