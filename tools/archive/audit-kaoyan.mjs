/**
 * 严格重审考研真题批次：按「数学类型是否一致」判断题干与解析是否配错。
 * 用法： node tools/archive/audit-kaoyan.mjs <db.json> [--apply]
 */
import fs from 'node:fs';

const DB = process.argv[2] || 'data/db.json';
const APPLY = process.argv.includes('--apply');

/* 数学类型特征词：题干与解析若命中不同类型，说明配错了 */
const TOPICS = [
  ['矩阵', [/矩阵/, /\\mathbf\{A\}/, /A\^\{-1\}/, /伴随/, /A\^\*/, /\|A\|/, /可逆/, /初等变换/, /分块/]],
  ['行列式', [/行列式/, /\\begin\{vmatrix\}/, /\\left\|/, /\|\s*\\begin\{array\}/]],
  ['向量', [/向量/, /线性相关/, /线性无关/, /秩/, /极大无关组/, /正交/]],
  ['特征值', [/特征值/, /特征向量/, /相似对角/, /二次型/, /正定/]],
  ['级数', [/级数/, /\\sum_\{n/, /收敛半径/, /幂级数/, /傅里叶/, /收敛域/]],
  ['微分方程', [/微分方程/, /通解/, /特解/, /特征方程/, /y\^\{\\prime\\prime\}/, /初值/]],
  ['极限', [/\\lim/, /极限/, /等价无穷小/, /洛必达/, /无穷小/]],
  ['导数', [/导数/, /f\^\{\\prime\}/, /可导/, /切线/, /极值/, /单调/, /拐点/]],
  ['偏导', [/偏导/, /\\partial/, /全微分/, /梯度/]],
  ['重积分', [/二重积分/, /三重积分/, /\\iint/, /\\iiint/, /累次积分/]],
  ['曲线曲面积分', [/曲线积分/, /曲面积分/, /\\oint/, /\\iint_\{\\Sigma\}/, /格林公式/, /高斯公式/, /斯托克斯/]],
  ['定积分', [/定积分/, /\\int_\{0\}/, /\\int_\{1\}/, /\\int_\{a\}/, /变限积分/, /反常积分/]],
  ['不定积分', [/不定积分/, /原函数/, /\\int /]],
  ['概率', [/概率/, /随机变量/, /分布函数/, /密度函数/, /正态分布/, /独立/, /协方差/, /期望/, /方差/, /大数定律/, /中心极限/]],
  ['空间解析几何', [/平面方程/, /直线方程/, /法向量/, /方向向量/, /曲面/, /旋转面/]],
];

function classify(text) {
  const hits = [];
  for (const [name, res] of TOPICS) {
    if (res.some((r) => r.test(text))) hits.push(name);
  }
  return hits;
}

/* 两组类型集合是否有交集（空集合不算证据） */
function compatible(a, b) {
  if (!a.length || !b.length) return true;   // 判不出来就放行，交给别的规则
  return a.some((x) => b.includes(x));
}

const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
const kaoyan = db.problems.filter((p) => (p.source || '').includes('硕士研究生招生考试'));

const reasons = { merged: [], topic: [], badAnswer: [], empty: [] };

for (const p of kaoyan) {
  const stem = p.statement || '';
  const sol = p.solution || '';
  const ans = (p.answer || '').trim();
  const isChoice = /选择题/.test(p.title || '');
  const isFill = /填空题/.test(p.title || '');

  if ((stem.match(/本题满分/g) || []).length > 1) { reasons.merged.push(p); continue; }

  if (!ans && !sol.trim()) { reasons.empty.push(p); continue; }

  if (isChoice && ans && !/^[（(]?\s*[ABCD]\s*[)）]?$/.test(ans)) { reasons.badAnswer.push(p); continue; }
  if (isFill && !ans) { reasons.empty.push(p); continue; }

  // 选择题/填空题：答案字母或数值必须能在解析里找到，否则多半配错了题
  if (ans && sol.trim()) {
    const letter = (ans.match(/[ABCD]/) || [])[0];
    const norm = (s) => String(s).replace(/[（()）\s.。]/g, '');
    const solNorm = norm(sol);
    if (letter) {
      // 解析里应出现「选 X」或「(X)」或「X.」这类结论
      const re = new RegExp('(应选|故选|答案|选)\\s*$|' , '');
      const hasLetter = new RegExp('(应选|故选|选|答案)[^。\\n]{0,6}' + letter).test(sol) || solNorm.indexOf(letter) >= 0;
      if (!hasLetter) { reasons.badAnswer.push(p); continue; }
    }
  }

  if (sol.trim()) {
    const a = classify(stem);
    const b = classify(sol);
    if (!compatible(a, b)) { reasons.topic.push(p); continue; }
  }
}

const bad = new Set();
for (const k of Object.keys(reasons)) for (const p of reasons[k]) bad.add(p.code);

console.log('考研题总数', kaoyan.length);
for (const k of Object.keys(reasons)) {
  const names = { merged: '题干合并了多题', topic: '题干与解析数学类型不符', badAnswer: '选择题答案不是 ABCD', empty: '答案与解析全空' };
  console.log('  ' + names[k] + ':', reasons[k].length);
}
console.log('判定不合格合计', bad.size, '｜通过', kaoyan.length - bad.size);

if (APPLY) {
  for (const p of db.problems) {
    if (!(p.source || '').includes('硕士研究生招生考试')) continue;
    if (bad.has(p.code)) {
      p.status = 'pending';
      p.rejectReason = p.rejectReason || '';
    } else {
      p.status = 'approved';
    }
  }
  fs.writeFileSync(DB, JSON.stringify(db, null, 2), 'utf8');
  console.log('已写回：不合格题转 pending');
} else {
  console.log('\n（预演模式，未写库。加 --apply 生效）');
  console.log('\n样本：');
  for (const k of Object.keys(reasons)) {
    for (const p of reasons[k].slice(0, 2)) {
      console.log(' [' + k + ']', p.code, '|', (p.statement || '').slice(0, 60).replace(/\n/g, ' '));
      console.log('        解析:', (p.solution || '(空)').slice(0, 60).replace(/\n/g, ' '));
    }
  }
}
