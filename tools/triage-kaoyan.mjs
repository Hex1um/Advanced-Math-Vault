/**
 * 考研真题批次分级上线：
 *  - 1987-1999：解析按节重编号、与真题顺序对不上，配对不可靠 → 全部 pending，等人工/AI 重配
 *  - 2000-2025：过「数学类型一致 + 答案与解析自洽」严格校验 → approved，否则 pending
 * 用法： node tools/triage-kaoyan.mjs [--apply]
 */
import fs from 'node:fs';

const DB = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'data/db.json';
const APPLY = process.argv.includes('--apply');

const TOPICS = [
  ['矩阵', [/矩阵/, /\\mathbf\{A\}/, /A\^\{-1\}/, /伴随/, /A\^\*/, /\|A\|/, /可逆/, /初等变换/, /分块/, /A\^\{T\}/, /A\^\{-1\}/]],
  ['行列式', [/行列式/, /\\begin\{vmatrix\}/, /\|\s*\\begin\{array\}/]],
  ['向量', [/向量/, /线性相关/, /线性无关/, /秩/, /极大无关组/, /正交/, /线性表出/]],
  ['特征值', [/特征值/, /特征向量/, /相似/, /二次型/, /正定/, /标准形/]],
  ['级数', [/级数/, /\\sum_\{n/, /收敛半径/, /幂级数/, /傅里叶/, /收敛域/, /和函数/]],
  ['微分方程', [/微分方程/, /通解/, /特解/, /特征方程/, /y\^\{\\prime\\prime\}/, /初值/, /齐次/]],
  ['极限', [/\\lim/, /极限/, /等价无穷小/, /洛必达/, /无穷小/, /夹逼/]],
  ['导数', [/导数/, /f\^\{\\prime\}/, /可导/, /切线/, /极值/, /单调/, /拐点/, /微分中值/]],
  ['偏导', [/偏导/, /\\partial/, /全微分/, /梯度/, /拉普拉斯/]],
  ['重积分', [/二重积分/, /三重积分/, /\\iint/, /\\iiint/, /累次积分/, /形心/]],
  ['曲线曲面积分', [/曲线积分/, /曲面积分/, /\\oint/, /\\iint_\{\\Sigma\}/, /格林公式/, /高斯公式/, /斯托克斯/]],
  ['定积分', [/定积分/, /\\int_\{0\}/, /\\int_\{1\}/, /\\int_\{a\}/, /变限积分/, /反常积分/]],
  ['不定积分', [/不定积分/, /原函数/, /\\int\s/]],
  ['概率', [/概率/, /随机变量/, /分布函数/, /密度/, /正态分布/, /独立/, /协方差/, /期望/, /方差/, /大数定律/, /中心极限/, /最大似然/, /估计量/]],
  ['空间解析几何', [/平面方程/, /直线方程/, /法向量/, /方向向量/, /旋转面/, /椭球面/, /切平面/]],
];

const classify = (t) => TOPICS.filter(([, res]) => res.some((r) => r.test(t))).map(([n]) => n);
const compatible = (a, b) => (!a.length || !b.length ? true : a.some((x) => b.includes(x)));

function verdict(p) {
  const stem = p.statement || '';
  const sol = (p.solution || '').trim();
  const ans = (p.answer || '').trim();
  const isChoice = /选择题/.test(p.title || '');
  const isFill = /填空题/.test(p.title || '');

  if ((stem.match(/本题满分/g) || []).length > 1) return '题干把多道题合并在一起';
  if (!ans && !sol) return '答案与解析全空';
  if (isChoice && ans && !/^[（(]?\s*[ABCD]\s*[)）]?$/.test(ans)) return '选择题答案不是 ABCD';
  if (isFill && !ans) return '填空题没有答案';

  if (sol) {
    const a = classify(stem), b = classify(sol);
    if (!compatible(a, b)) return '题干与解析数学类型不符（' + a.join('/') + ' vs ' + b.join('/') + '）';
    // 选择题：答案字母要能在解析里找到结论
    const letter = (ans.match(/[ABCD]/) || [])[0];
    if (letter && isChoice) {
      const ok = new RegExp('(应选|故选|选|答案)[^。\\n]{0,8}' + letter).test(sol) || sol.indexOf('(' + letter + ')') >= 0 || sol.indexOf('（' + letter + '）') >= 0;
      if (!ok) return '解析结论与所给答案 ' + letter + ' 不一致';
    }
    // 符号一致性：题干里的具体数学符号（希腊字母/函数名/数字）应至少有一个出现在解析里
    const sym = (t) => {
      const s = new Set();
      for (const m of t.matchAll(/\\(alpha|beta|gamma|theta|lambda|mu|sigma|xi|eta|pi|rho|phi|omega|varphi)/g)) s.add(m[1]);
      for (const m of t.matchAll(/(\d+)/g)) s.add('n' + m[1]);
      for (const m of t.matchAll(/(f|g|u|v|y|z|A|B|X|Y|F)\b/g)) s.add(m[1]);
      return s;
    };
    const a1 = sym(stem), b1 = sym(sol);
    if (a1.size >= 2 && b1.size) {
      const hit = [...a1].filter((x) => b1.has(x)).length;
      if (hit === 0) return '题干预解析没有共同的数学符号';
    }
  }
  return '';
}

const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
const ky = db.problems.filter((p) => (p.source || '').includes('硕士研究生招生考试'));
const groups = { early: [], late: [] };
for (const p of ky) {
  const y = Number((p.source || '').slice(0, 4));
  (y <= 1999 ? groups.early : groups.late).push(p);
}

let keep = 0, pend = 0;
const detail = {};
for (const p of groups.early) {
  p.status = 'pending';
  p.rejectReason = '';
  pend++;
}
for (const p of groups.late) {
  const v = verdict(p);
  if (v) {
    p.status = 'pending';
    detail[v] = (detail[v] || 0) + 1;
    pend++;
  } else {
    p.status = 'approved';
    keep++;
  }
}

console.log('考研题总数', ky.length);
console.log('  1987-1999（配对不可靠，整批待审）:', groups.early.length);
console.log('  2000+ 上线:', keep, '｜2000+ 转待审:', groups.late.length - keep);
console.log('  待审合计:', pend, '｜上线合计:', keep);
if (Object.keys(detail).length) {
  console.log('\n2000+ 待审原因：');
  for (const [k, v] of Object.entries(detail).sort((a, b) => b[1] - a[1])) console.log('  ' + v + ' × ' + k);
}

if (APPLY) {
  fs.writeFileSync(DB, JSON.stringify(db, null, 2), 'utf8');
  const st = {};
  for (const p of db.problems) st[p.status] = (st[p.status] || 0) + 1;
  console.log('\n已写库。全库状态：', st, '总计', db.problems.length);
} else {
  console.log('\n（预演，未写库。加 --apply 生效）');
}
