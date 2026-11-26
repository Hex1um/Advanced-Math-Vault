#!/usr/bin/env node
/**
 * lib/physics-equiv.js 单测。
 *
 * 覆盖：SI 单位换算、词头、导出单位、复合单位（J/(kg·K)）、量纲报错、
 * 相对误差边界、有效数字提示、缺单位容错、符号等价降级、非法单位。
 *
 * 用法：node tools/verify/check-physics-equiv.mjs [--verbose]
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const pe = require(path.join(ROOT, 'lib/physics-equiv.js'));

const verbose = process.argv.includes('--verbose');
let pass = 0;
const fails = [];

function t(name, fn) {
  try {
    fn();
    pass++;
    if (verbose) console.log('  ok   ' + name);
  } catch (e) {
    fails.push(name + '：' + e.message);
    console.log('  FAIL ' + name + '：' + e.message);
  }
}

function eq(actual, expected, hint) {
  if (actual !== expected) throw new Error((hint ? hint + ' ' : '') + '期望 ' + expected + '，实际 ' + actual);
}

function near(actual, expected, rel, hint) {
  const d = Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-30);
  if (!(d <= (rel || 1e-9))) throw new Error((hint ? hint + ' ' : '') + '期望 ' + expected + '，实际 ' + actual);
}

console.log('physics-equiv 单测');

/* ---------------- 1. 单位换算（数值型） ---------------- */
const numericCases = [
  // [学生答案, 标准答案, meta, 期望 verdict]
  ['72 km/h', '20 m/s', {}, 'correct'],
  ['20 m/s', '20 m/s', {}, 'correct'],
  ['20', '20 m/s', { unit: 'm/s' }, 'correct'],                    // 缺单位按标准单位理解
  ['1.6e-19 J', '1.602176634e-19 J', { tolRel: 0.02 }, 'correct'],
  ['1 eV', '1.602176634e-19 J', {}, 'correct'],
  ['1.6\\times10^{-19}\\ \\mathrm{J}', '1.602e-19 J', {}, 'correct'],
  ['2.5 N·m', '2.5 J', {}, 'correct'],                              // 力矩与能量同量纲
  ['1 kcal', '4184 J', {}, 'correct'],
  ['1 kWh', '3.6e6 J', {}, 'correct'],
  ['1 μm', '1e-6 m', {}, 'correct'],
  ['1 Å', '1e-10 m', {}, 'correct'],
  ['1000 g', '1 kg', {}, 'correct'],
  ['1 t', '1000 kg', {}, 'correct'],
  ['1 g/cm^3', '1000 kg/m^3', {}, 'correct'],
  ['30 deg', '0.5235987756 rad', { tolRel: 0.001 }, 'correct'],
  ['60 rpm', '6.283185 rad/s', { tolRel: 0.001 }, 'correct'],
  ['1 atm', '101325 Pa', {}, 'correct'],
  ['1 mmHg', '133.322 Pa', { tolRel: 0.001 }, 'correct'],
  ['1 bar', '1e5 Pa', {}, 'correct'],
  ['1 erg', '1e-7 J', {}, 'correct'],
  ['1 Gs', '1e-4 T', {}, 'correct'],
  ['5 μF', '5e-6 F', {}, 'correct'],
  ['2 mH', '2e-3 H', {}, 'correct'],
  ['4186 J/(kg*K)', '4186 J kg^-1 K^-1', {}, 'correct'],
  ['8.85e-12 F/m', '8.85e-12 F/m', {}, 'correct'],
  ['1.5e11 m', '1.5e8 km', {}, 'correct'],
  ['3.0e8 m/s', '3.0e8 m/s', {}, 'correct'],
  ['0.5 m/s^2', '0.5 m/s2', {}, 'correct'],                          // s2 视为 s^2
  ['2.04 m/s', '2 m/s', { tolRel: 0.02 }, 'correct'],                // 容差边界包含
  ['-9.8 m/s^2', '-9.8 m/s^2', {}, 'correct'],
  ['9.8 N/kg', '9.8 m/s^2', {}, 'correct']                           // 同量纲不同写法
];

for (const [user, ref, meta, want] of numericCases) {
  t('数值 ' + user + ' vs ' + ref, () => {
    const out = pe.checkAnswer(user, ref, meta);
    eq(out.verdict, want, out.detail);
  });
}

/* ---------------- 2. 量纲报错 ---------------- */
const dimCases = [
  ['9.8 m/s', '9.8 m/s^2'],
  ['20 m/s', '20 m'],
  ['1 N', '1 J'],
  ['5 V', '5 A'],
  ['1 kg', '1 mol'],
  ['3 m^3', '3 m^2']
];
for (const [user, ref] of dimCases) {
  t('量纲 ' + user + ' vs ' + ref, () => {
    const out = pe.checkAnswer(user, ref, {});
    eq(out.verdict, 'dimensionMismatch', out.detail);
    if (!/量纲不一致/.test(out.detail)) throw new Error('诊断文案缺「量纲不一致」');
  });
}

/* ---------------- 3. 数值容差 ---------------- */
t('超出容差判错', () => {
  const out = pe.checkAnswer('2.05 m/s', '2 m/s', { tolRel: 0.02 });
  eq(out.verdict, 'valueOff');
});
t('自定义 5% 容差放行', () => {
  const out = pe.checkAnswer('2.08 m/s', '2 m/s', { tolRel: 0.05 });
  eq(out.verdict, 'correct');
});
t('零值附近不炸（除以 1e-12 保护）', () => {
  const out = pe.checkAnswer('0 m/s', '0 m/s', {});
  eq(out.verdict, 'correct');
});
t('相对误差字段可用', () => {
  const out = pe.checkAnswer('2.02 m/s', '2 m/s', { tolRel: 0.02 });
  near(out.relErr, 0.01, 1e-6);
});

/* ---------------- 4. 有效数字与缺单位提示 ---------------- */
t('有效数字偏差给非致命提示', () => {
  const out = pe.checkAnswer('9.80665 m/s^2', '9.8 m/s^2', { sigFigs: 2, tolRel: 0.02 });
  eq(out.verdict, 'correct');
  if (!out.warnings || !out.warnings.some((w) => /有效数字/.test(w))) {
    throw new Error('未提示有效数字，实际 warnings=' + JSON.stringify(out.warnings));
  }
});
t('缺单位时提示但不判错', () => {
  const out = pe.checkAnswer('20', '20 m/s', { unit: 'm/s' });
  eq(out.verdict, 'correct');
  if (!out.warnings || !out.warnings.some((w) => /没写单位/.test(w))) {
    throw new Error('未提示缺单位');
  }
});

/* ---------------- 5. 非法单位与坏指数 ---------------- */
t('无法识别的单位给出 unitUnknown', () => {
  const out = pe.checkAnswer('20 furlong/s', '20 m/s', {});
  eq(out.verdict, 'unitUnknown');
  if (!/无法识别/.test(out.detail)) throw new Error('文案不对：' + out.detail);
});
t('坏指数不崩', () => {
  const out = pe.parseUnitExpr('m^x');
  eq(out.error, 'bad_exponent');
});
t('括号不闭合不崩', () => {
  const out = pe.parseUnitExpr('J/(kg');
  if (!out.error && !out.dim) throw new Error('既没报错也没结果');
});

/* ---------------- 6. 符号题与降级 ---------------- */
t('符号题不走数值判，返回 deferred', () => {
  const out = pe.checkAnswer('\\frac{3v_0}{2L}', '\\frac{3v_0}{2L}', { answerType: 'symbolic' });
  if (!(out.ok || out.deferred)) throw new Error('既没判对也没降级');
});
t('符号题完全等价时判对', () => {
  const out = pe.checkAnswer('\\frac{3 v_0}{2 L}', '3v_0/(2L)', { answerType: 'symbolic' });
  if (!out.ok && !out.deferred) throw new Error('既没判对也没降级');
});
t('答案是文字时降级给 AI', () => {
  const out = pe.checkAnswer('沿 +x 方向', '沿 +x 方向', { answerType: 'vector' });
  eq(out.deferred, true);
});
t('作答为空直接降级', () => {
  const out = pe.checkAnswer('', '20 m/s', {});
  eq(out.deferred, true);
});

/* ---------------- 7. 解析器单元行为 ---------------- */
t('词头优先级：min 不是 milli-in', () => {
  const u = pe.parseUnitExpr('min');
  eq(u.factor, 60);
});
t('词头优先级：T 是特斯拉', () => {
  const u = pe.parseUnitExpr('T');
  eq(pe.describeDim(u.dim), '磁感应强度');
});
t('毫特斯拉 mT', () => {
  const u = pe.parseUnitExpr('mT');
  near(u.factor, 1e-3, 1e-12);
});
t('复合单位量纲正确', () => {
  const u = pe.parseUnitExpr('kg*m/s^2');
  eq(pe.describeDim(u.dim), '力 / 重量');
});
t('比热容量纲', () => {
  const u = pe.parseUnitExpr('J/(kg*K)');
  eq(pe.formatDim(u.dim), 'L^2 T^-2 K^-1');
});
t('单位串里的 LaTeX 能解析', () => {
  const u = pe.parseUnitExpr('\\mathrm{m/s^2}');
  eq(pe.describeDim(u.dim), '加速度');
});
t('Unicode 上标能解析', () => {
  const u = pe.parseUnitExpr('m·s⁻²');
  eq(pe.describeDim(u.dim), '加速度');
});
t('无量纲比值', () => {
  const u = pe.parseUnitExpr('m/m');
  eq(pe.describeDim(u.dim), '无量纲');
});

/* ---------------- 8. 自动判题判定 ---------------- */
t('数值+单位题可自动判', () => {
  eq(pe.canAutoJudge({ answer: '20 m/s', physicsMeta: { answerType: 'numeric_unit' } }), true);
});
t('推导题不自动判', () => {
  eq(pe.canAutoJudge({ answer: '\\frac{3v_0}{2L}', physicsMeta: { answerType: 'symbolic' } }), false);
});
t('符号答案但无 meta 时不自动判', () => {
  eq(pe.canAutoJudge({ answer: '\\frac{mv^2}{2}' }), false);
});
t('带单位的数值答案无 meta 也可自动判', () => {
  eq(pe.canAutoJudge({ answer: '9.8 m/s^2' }), true);
});

/* ---------------- 9. 天文单位与天文标度 ---------------- */
const astroCases = [
  ['1 pc', '3.0857e16 m', {}],
  ['1 kpc', '3.0857e19 m', {}],
  ['1 Mpc', '3.0857e22 m', {}],
  ['1 Gpc', '3.0857e25 m', {}],
  ['1 ly', '9.4607e15 m', {}],
  ['1 AU', '1.496e11 m', {}],
  ['1 Msun', '1.989e30 kg', {}],
  ['1 M_sun', '1.989e30 kg', {}],
  ['1 Lsun', '3.828e26 W', {}],
  ['1 R_sun', '6.957e8 m', {}],
  ['1 Mearth', '5.972e24 kg', {}],
  ['1 Myr', '3.156e13 s', {}],
  ['1 Gyr', '3.156e16 s', {}],
  ['1.17e10 yr', '11.7 Gyr', {}],
  ['1 Jy', '1e-26 W/m^2/Hz', {}],
  ['10 km/s', '1e4 m/s', {}],
  ['70 km/(s*Mpc)', '2.27e-18 s^-1', { tolRel: 0.05 }],
  ['8500 K', '8500 K', {}],
  ['2.725 K', '2.725 K', {}]
];
for (const [user, ref, meta] of astroCases) {
  t('天文 ' + user + ' vs ' + ref, () => {
    const out = pe.checkAnswer(user, ref, meta);
    eq(out.verdict, 'correct', out.detail);
  });
}

/* ---------------- 10. CGS 高斯制 ---------------- */
t('esu 与 C 在高斯制下同量纲（不校验电流维）', () => {
  const out = pe.checkAnswer('1 esu', '3.3356e-10 C', { unitSystem: 'CGS' });
  eq(out.verdict, 'correct', out.detail);
});
t('高斯制下 esu 数值不符仍判错', () => {
  const out = pe.checkAnswer('1 esu', '1 C', { unitSystem: 'CGS' });
  eq(out.verdict, 'valueOff');
});
t('高斯制 Gs 与 T 换算', () => {
  const out = pe.checkAnswer('1 Gs', '1e-4 T', { unitSystem: 'CGS' });
  eq(out.verdict, 'correct', out.detail);
});
t('高斯制 Oe 与 A/m', () => {
  const out = pe.checkAnswer('1 Oe', '79.577 A/m', { unitSystem: 'CGS', tolRel: 0.01 });
  eq(out.verdict, 'correct', out.detail);
});
t('高斯制 Mx 与 Wb', () => {
  const out = pe.checkAnswer('1 Mx', '1e-8 Wb', { unitSystem: 'CGS' });
  eq(out.verdict, 'correct', out.detail);
});
t('CGS 力学单位 erg', () => {
  const out = pe.checkAnswer('1 erg', '1e-7 J', { unitSystem: 'CGS' });
  eq(out.verdict, 'correct');
});
t('CGS 力学单位 dyn', () => {
  const out = pe.checkAnswer('1 dyn', '1e-5 N', { unitSystem: 'CGS' });
  eq(out.verdict, 'correct');
});
t('CGS 单位 Ba 与 Pa', () => {
  const out = pe.checkAnswer('1 Ba', '0.1 Pa', { unitSystem: 'CGS' });
  eq(out.verdict, 'correct');
});
t('SI 模式下 esu 与 C 仍按电流维比较', () => {
  const out = pe.checkAnswer('1 esu', '3.3356e-10 C', { unitSystem: 'SI' });
  eq(out.verdict, 'correct');
});
t('natural 单位不卡量纲', () => {
  const out = pe.checkAnswer('1 GeV', '1 GeV', { unitSystem: 'natural' });
  eq(out.verdict, 'correct');
});

/* ---------------- 11. 数量级估算（order_of_magnitude） ---------------- */
const om = (u, r, tolDex) => pe.checkAnswer(u, r, { answerType: 'order_of_magnitude', tolDex: tolDex === undefined ? 0.3 : tolDex });
t('量级：2 倍以内判对（边界含等号）', () => { eq(om('1e11 Msun', '2e11 Msun').verdict, 'correct'); });
t('量级：1.4 倍判对', () => { eq(om('7e10 Msun', '1e11 Msun').verdict, 'correct'); });
t('量级：10 倍判错', () => { eq(om('1e12 Msun', '1e11 Msun').verdict, 'valueOff'); });
t('量级：给出 dex 偏差', () => {
  const out = om('1e12 Msun', '1e11 Msun');
  near(out.dexErr, 1, 1e-6, 'dexErr');
});
t('量级：0.5 dex 容差放行 3 倍', () => { eq(om('3e10 yr', '1e10 yr', 0.5).verdict, 'correct'); });
t('量级：符号相反直接判错', () => { eq(om('-1e11 Msun', '1e11 Msun').verdict, 'valueOff'); });
t('量级：跨单位（kg 与 Msun）', () => { eq(om('2e30 kg', '1 Msun').verdict, 'correct'); });
t('量级：模式写在 detail 里', () => { eq(om('1e11 Msun', '1e11 Msun').mode, 'order_of_magnitude'); });
t('量级：普通模式不受 tolDex 影响', () => {
  const out = pe.checkAnswer('2.04 m/s', '2 m/s', { tolRel: 0.02, tolDex: 0 });
  eq(out.mode, 'numeric_unit');
});
t('canAutoJudge 认可 order_of_magnitude', () => {
  eq(pe.canAutoJudge({ answer: '1e11 Msun', physicsMeta: { answerType: 'order_of_magnitude' } }), true);
});

/* ---------------- 12. 单位制元数据 ---------------- */
t('UNIT_SYSTEMS 覆盖四套', () => {
  eq(pe.UNIT_SYSTEMS.join(','), 'SI,CGS,astro,natural');
});
t('未知单位制回退 SI 行为', () => {
  const out = pe.checkAnswer('1 m', '1 m', { unitSystem: 'MKS' });
  eq(out.verdict, 'correct');
});
t('天文单位串 \odot 写法', () => {
  const u = pe.parseUnitExpr('M_{\\odot}');
  near(u.factor, 1.98847e30, 1e-3);
});
t('Jy 量纲等于 kg/s^2', () => {
  const u = pe.parseUnitExpr('Jy');
  eq(pe.formatDim(u.dim), 'M T^-2');
});
t('pc 与 m 量纲一致', () => {
  eq(pe.describeDim(pe.parseUnitExpr('pc').dim), '长度');
});

/* ---------------- 汇总 ---------------- */
const total = pass + fails.length;
console.log('\n共 ' + total + ' 项：通过 ' + pass + '，失败 ' + fails.length);
if (fails.length) {
  console.log('\n失败明细：');
  for (const f of fails) console.log(' - ' + f);
  process.exit(1);
}
console.log('physics-equiv 全部通过');
