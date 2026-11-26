'use strict';
/**
 * 零依赖物理判题引擎：单位换算 → 量纲一致性 → 数值容差 / 有效数字 → 符号等价。
 *
 * 设计约束（与项目三大架构原则一致）：
 *   1. 不引入任何 npm 依赖：单位表、词头表、量纲向量全部手写常量；
 *   2. 只做**确定性**判定，判不了就返回 `deferred: true` 交给 AI 批改，
 *      不用猜；宁可降级，不可误判；
 *   3. 对数学层零侵入：符号等价仍由 lib/math-equiv.js 负责，这里只做单位与量纲。
 *
 * 量纲向量取 7 个 SI 基本量，顺序固定：
 *   [M 质量, L 长度, T 时间, I 电流, K 热力学温度, N 物质的量, J 发光强度]
 *
 * 为什么单独建一个引擎而不是在 math-equiv 里加分支：
 *   数学等价关心「表达式是否恒等」，物理判题关心「数值 + 单位 + 量纲是否说得通」。
 *   `72 km/h` 与 `20 m/s` 在数学上根本不等（72≠20），在物理上是同一个答案；
 *   `9.8 m/s` 与 `9.8 m/s^2` 数值相同、量纲不同，必须报「量纲错」而不是「算错了」。
 */

const { isMathEquivalent } = require('./math-equiv');

const BASE_KEYS = ['M', 'L', 'T', 'I', 'K', 'N', 'J'];

function zeros() {
  return [0, 0, 0, 0, 0, 0, 0];
}

function vec(m, l, t, i, k, n, j) {
  return [
    Number(m) || 0, Number(l) || 0, Number(t) || 0, Number(i) || 0,
    Number(k) || 0, Number(n) || 0, Number(j) || 0
  ];
}

/* ---------------------------------------------------------------- 单位表
 * factor 一律换算到 SI 基本单位（kg / m / s / A / K / mol / cd）。
 * 用「符号数组」而不是对象字面量，便于保留书写顺序与重复检测。 */
const UNIT_DEFS = [
  /* SI 基本单位 */
  ['kg', 1, vec(1, 0, 0)],
  ['m', 1, vec(0, 1, 0)],
  ['s', 1, vec(0, 0, 1)],
  ['A', 1, vec(0, 0, 0, 1)],
  ['K', 1, vec(0, 0, 0, 0, 1)],
  ['mol', 1, vec(0, 0, 0, 0, 0, 1)],
  ['cd', 1, vec(0, 0, 0, 0, 0, 0, 1)],
  /* 质量 / 长度 / 时间 常用单位 */
  ['g', 1e-3, vec(1, 0, 0)],
  ['t', 1e3, vec(1, 0, 0)],
  ['u', 1.66053906660e-27, vec(1, 0, 0)],
  ['km', 1e3, vec(0, 1, 0)],
  ['cm', 1e-2, vec(0, 1, 0)],
  ['mm', 1e-3, vec(0, 1, 0)],
  ['μm', 1e-6, vec(0, 1, 0)],
  ['um', 1e-6, vec(0, 1, 0)],
  ['nm', 1e-9, vec(0, 1, 0)],
  ['pm', 1e-12, vec(0, 1, 0)],
  ['Å', 1e-10, vec(0, 1, 0)],
  ['in', 0.0254, vec(0, 1, 0)],
  ['ft', 0.3048, vec(0, 1, 0)],
  ['mile', 1609.344, vec(0, 1, 0)],
  ['min', 60, vec(0, 0, 1)],
  ['h', 3600, vec(0, 0, 1)],
  ['d', 86400, vec(0, 0, 1)],
  ['yr', 3.15576e7, vec(0, 0, 1)],
  /* 力学导出单位 */
  ['N', 1, vec(1, 1, -2)],
  ['J', 1, vec(1, 2, -2)],
  ['W', 1, vec(1, 2, -3)],
  ['Pa', 1, vec(1, -1, -2)],
  ['Hz', 1, vec(0, 0, -1)],
  ['dyn', 1e-5, vec(1, 1, -2)],
  ['erg', 1e-7, vec(1, 2, -2)],
  ['atm', 101325, vec(1, -1, -2)],
  ['bar', 1e5, vec(1, -1, -2)],
  ['mmHg', 133.322387415, vec(1, -1, -2)],
  ['Torr', 133.322387415, vec(1, -1, -2)],
  /* 电磁学导出单位 */
  ['C', 1, vec(0, 0, 1, 1)],
  ['V', 1, vec(1, 2, -3, -1)],
  ['Ω', 1, vec(1, 2, -3, -2)],
  ['ohm', 1, vec(1, 2, -3, -2)],
  ['F', 1, vec(-1, -2, 4, 2)],
  ['H', 1, vec(1, 2, -2, -2)],
  ['T', 1, vec(1, 0, -2, -1)],
  ['Wb', 1, vec(1, 2, -2, -1)],
  ['S', 1, vec(-1, -2, 3, 2)],
  ['Gs', 1e-4, vec(1, 0, -2, -1)],
  ['gauss', 1e-4, vec(1, 0, -2, -1)],
  ['Oe', 1000 / (4 * Math.PI), vec(0, -1, 0, 1)],
  /* 热学 / 物质 */
  ['cal', 4.184, vec(1, 2, -2)],
  ['kcal', 4184, vec(1, 2, -2)],
  ['eV', 1.602176634e-19, vec(1, 2, -2)],
  ['kWh', 3.6e6, vec(1, 2, -2)],
  ['L', 1e-3, vec(0, 3, 0)],
  ['l', 1e-3, vec(0, 3, 0)],
  /* 角度（无量纲）与转速 */
  ['rad', 1, vec(0, 0, 0)],
  ['sr', 1, vec(0, 0, 0)],
  ['deg', Math.PI / 180, vec(0, 0, 0)],
  ['°', Math.PI / 180, vec(0, 0, 0)],
  ['rpm', (2 * Math.PI) / 60, vec(0, 0, -1)],
  /* 百分比：无量纲，系数 0.01。40% 与 0.4 是同一个答案。 */
  ['%', 0.01, vec(0, 0, 0)]
];

const UNITS = new Map();
for (const [sym, factor, dim] of UNIT_DEFS) UNITS.set(sym, { sym: sym, factor: factor, dim: dim });

/* SI 词头。解析顺序：先精确匹配整串单位，再尝试「词头 + 已知单位」，
   所以 `min`（分钟）不会被拆成 milli-in，`T`（特斯拉）不会被当成 tera。 */
const PREFIXES = [
  ['da', 1e1], ['p', 1e-12], ['n', 1e-9], ['μ', 1e-6], ['u', 1e-6], ['m', 1e-3],
  ['c', 1e-2], ['d', 1e-1], ['h', 1e2], ['k', 1e3], ['M', 1e6], ['G', 1e9],
  ['T', 1e12], ['P', 1e15], ['E', 1e18], ['f', 1e-15], ['a', 1e-18]
].sort(function (a, b) { return b[0].length - a[0].length; });

/* 常见误写 → 规范符号（学生手打的高频变体） */
const SYMBOL_ALIASES = {
  'Ω': 'Ω', 'Ohm': 'Ω', 'OHM': 'Ω', 'ohms': 'Ω',
  'µ': 'μ', 'u': 'μ',
  'm/s': 'm/s', 'M/S': 'm/s', 'KM/H': 'km/h',
  'sec': 's', 'Sec': 's', 'second': 's', 'seconds': 's',
  'minute': 'min', 'minutes': 'min', 'hr': 'h', 'hour': 'h', 'hours': 'h',
  'meter': 'm', 'meters': 'm', 'metre': 'm', 'gram': 'g', 'grams': 'g',
  'newton': 'N', 'joule': 'J', 'watt': 'W', 'pascal': 'Pa', 'volt': 'V',
  'ampere': 'A', 'amp': 'A', 'coulomb': 'C', 'farad': 'F', 'henry': 'H',
  'tesla': 'T', 'weber': 'Wb', 'kelvin': 'K', 'mole': 'mol',
  '度': '°'
};

/* 常见量纲的友好名字：诊断信息里用，避免给学生甩一串 [0,1,-1] */
const DIM_NAMES = [
  { dim: vec(0, 0, 0), name: '无量纲' },
  { dim: vec(1, 0, 0), name: '质量' },
  { dim: vec(0, 1, 0), name: '长度' },
  { dim: vec(0, 0, 1), name: '时间' },
  { dim: vec(0, 0, -1), name: '频率 / 角速度' },
  { dim: vec(0, 1, -1), name: '速度' },
  { dim: vec(0, 1, -2), name: '加速度' },
  { dim: vec(0, 2, 0), name: '面积' },
  { dim: vec(0, 3, 0), name: '体积' },
  { dim: vec(0, 1, -3), name: '体积流量' },
  { dim: vec(1, 1, -2), name: '力 / 重量' },
  { dim: vec(1, 2, -2), name: '能量 / 功 / 力矩' },
  { dim: vec(1, 2, -3), name: '功率' },
  { dim: vec(1, -1, -2), name: '压强' },
  { dim: vec(1, -3, 0), name: '密度' },
  { dim: vec(0, 0, 1, 1), name: '电荷量' },
  { dim: vec(0, 0, -1, 1), name: '电流' },
  { dim: vec(1, 2, -3, -1), name: '电势 / 电压' },
  { dim: vec(1, 2, -3, -2), name: '电阻' },
  { dim: vec(-1, -2, 4, 2), name: '电容' },
  { dim: vec(1, 2, -2, -1), name: '磁通量' },
  { dim: vec(1, 0, -2, -1), name: '磁感应强度' },
  { dim: vec(1, 2, -2, -2), name: '电感' },
  { dim: vec(0, 0, 0, 0, 1), name: '温度' },
  { dim: vec(0, 0, 0, 0, 0, 1), name: '物质的量' },
  { dim: vec(-1, 2, -2), name: '比热容 / 熵' }
];

function sameVec(a, b) {
  for (let i = 0; i < 7; i++) if (Math.abs((a[i] || 0) - (b[i] || 0)) > 1e-9) return false;
  return true;
}

function addVec(a, b, sign) {
  const out = zeros();
  const k = sign === undefined ? 1 : sign;
  for (let i = 0; i < 7; i++) out[i] = (a[i] || 0) + k * (b[i] || 0);
  return out;
}

function formatDim(dim) {
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const e = dim[i] || 0;
    if (!e) continue;
    parts.push(BASE_KEYS[i] + (e === 1 ? '' : '^' + e));
  }
  return parts.length ? parts.join(' ') : '1';
}

function describeDim(dim) {
  for (const row of DIM_NAMES) if (sameVec(row.dim, dim)) return row.name;
  return formatDim(dim);
}

/* ------------------------------------------------------------ 文本归一化
 * 把 LaTeX / Unicode 写法压成「数 + 单位表达式」可直接解析的形式。 */
const SUP_MAP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+' };

function normalizeSuperscripts(s) {
  return String(s).replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, function (run) {
    let out = '';
    for (const ch of run) out += SUP_MAP[ch];
    return '^{' + out + '}';
  });
}

function normalizeUnitsText(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/\$\$?/g, ' ');
  s = s.replace(/\\[()[\]]/g, ' ');
  s = normalizeSuperscripts(s);
  /* \mathrm{m/s^2} / \text{...} / \operatorname{...} / \mathrm{m\,s^{-1}} */
  s = s.replace(/\\(?:mathrm|text|textrm|operatorname|mbox|rm)\s*\{([^{}]*)\}/g, '$1');
  /* \frac{a}{b} → a/b（单位里极常见：J/mol、m/s） */
  s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
  s = s.replace(/\\cdot|\\times|\\!|\\,|\\;|\\ /g, '*');
  s = s.replace(/[·⋅∙×✕]/g, '*');
  s = s.replace(/\\circ/g, '°');
  s = s.replace(/\\mu\b/g, 'μ');
  s = s.replace(/\\Omega\b/g, 'Ω');
  s = s.replace(/\\AA\b/g, 'Å');
  s = s.replace(/\^\{([^{}]+)\}/g, '^$1');
  s = s.replace(/[{}]/g, '');
  s = s.replace(/\u00a0|\u3000/g, ' ');
  return s.trim();
}

/** 把 "1.6e-19"、"1.6×10^-19"、"1.6\\times10^{-19}" 统一成可 number() 的形式 */
function normalizeNumberText(raw) {
  let s = String(raw);
  s = s.replace(/[×✕·⋅]/g, '*').replace(/\\times/g, '*');
  s = s.replace(/\*\s*10\s*\^\s*\(?([-+]?\d+)\)?/g, 'e$1');
  s = s.replace(/\*10\s*\^\{?([-+]?\d+)\}?/g, 'e$1');
  return s;
}

/* --------------------------------------------------------------- 单位解析
 * 递归下降，支持：m/s^2、kg*m/s^2、J/(kg*K)、N·m、m s^-1、μF、km/h。
 * 除法作用于紧随其后的**整个因子**（含括号组），所以 J/(kg*K) 不会被算成 J/kg*K。
 */
function tokenizeUnitExpr(src) {
  const s = src;
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '*' || ch === '/' || ch === '(' || ch === ')' || ch === '^') { tokens.push(ch); i++; continue; }
    if (/\d/.test(ch) || (ch === '-' && tokens[tokens.length - 1] === '^')) {
      let j = i;
      if (ch === '-' || ch === '+') j++;
      while (j < s.length && /[\d.]/.test(s[j])) j++;
      tokens.push(s.slice(i, j));
      i = j;
      continue;
    }
    let j = i;
    while (j < s.length && !/[\s*/()^]/.test(s[j])) j++;
    const word = s.slice(i, j);
    /* m/s2、s2 这类漏写 ^ 的写法：把词尾数字拆成指数（单位符号本身不含数字） */
    const m = /^([A-Za-zμΩÅ°℃]+)(\d+)$/.exec(word);
    if (m) {
      tokens.push(m[1], '^', m[2]);
    } else {
      tokens.push(word);
    }
    i = j;
  }
  return tokens;
}

function resolveUnitSymbol(sym) {
  const raw = String(sym || '').trim();
  if (!raw) return null;
  const alias = SYMBOL_ALIASES[raw];
  const key = alias || raw;
  if (UNITS.has(key)) return UNITS.get(key);
  /* 词头 + 基本单位（长的优先，避免 μ 被当成 m） */
  for (const [pfx, factor] of PREFIXES) {
    if (key.length > pfx.length && key.indexOf(pfx) === 0) {
      const rest = key.slice(pfx.length);
      if (UNITS.has(rest)) {
        const base = UNITS.get(rest);
        return { sym: key, factor: base.factor * factor, dim: base.dim };
      }
    }
  }
  /* 大小写不敏感兜底：m/s 类写法滥用大写（KM/H） */
  const lower = key.toLowerCase();
  for (const [sym2, def] of UNITS) {
    if (sym2.toLowerCase() === lower) return def;
  }
  return null;
}

function parseUnitExpr(src) {
  const text = normalizeUnitsText(src);
  if (!text) return { factor: 1, dim: zeros(), empty: true, text: '' };
  /* 无运算符时把相邻空白视为乘号：已在归一化里把 \cdot 等换掉，
     这里处理 "kg m" 这种纯空格写法 */
  const spaced = text.replace(/([A-Za-zΩμÅ°℃\)])\s+(?=[A-Za-zΩμÅ°℃\(])/g, '$1*');
  const tokens = tokenizeUnitExpr(spaced);
  let pos = 0;

  function parseExpr() {
    let acc = { factor: 1, dim: zeros() };
    let op = '*';
    while (pos < tokens.length) {
      const tok = tokens[pos];
      if (tok === ')') break;
      if (tok === '*' || tok === '/') { op = tok; pos++; continue; }
      const f = parseFactor();
      if (f.error) return f;
      const sign = op === '/' ? -1 : 1;
      acc.factor *= sign === 1 ? f.factor : 1 / f.factor;
      acc.dim = addVec(acc.dim, f.dim, sign);
      op = '*';
    }
    return acc;
  }

  function parseFactor() {
    const tok = tokens[pos];
    if (tok === '(') {
      pos++;
      const inner = parseExpr();
      if (inner.error) return inner;
      if (tokens[pos] === ')') pos++;
      return parsePower(inner);
    }
    if (tok === undefined) return { factor: 1, dim: zeros() };
    /* 纯数字因子（如 1/s、10^3 N）：按无量纲处理 */
    if (/^[-+]?[\d.]+$/.test(tok)) {
      pos++;
      let power = 1;
      if (tokens[pos] === '^') { power = Number(tokens[pos + 1]); pos += 2; }
      return { factor: Math.pow(Number(tok), power), dim: zeros() };
    }
    const def = resolveUnitSymbol(tok);
    pos++;
    if (!def) {
      return { error: 'unknown_unit', token: tok, text: text };
    }
    return parsePower(def);
  }

  function parsePower(def) {
    let power = 1;
    if (tokens[pos] === '^') {
      const num = Number(tokens[pos + 1]);
      if (!Number.isFinite(num)) return { error: 'bad_exponent', text: text };
      power = num;
      pos += 2;
    }
    const dim = zeros();
    for (let i = 0; i < 7; i++) dim[i] = (def.dim[i] || 0) * power;
    return { factor: Math.pow(def.factor, power), dim: dim, sym: def.sym };
  }

  const out = parseExpr();
  if (out.error) return out;
  if (pos < tokens.length) return { error: 'trailing_tokens', text: text };
  return { factor: out.factor, dim: out.dim, text: text };
}

/* --------------------------------------------------------- 数量解析
 * 返回 { value, unitText, scale, dim, knownUnit }：
 *   value × scale = 以 SI 基本单位表示的数值
 *   knownUnit=false 表示单位串解析失败（区别于「没有单位」） */
function parseQuantity(raw) {
  const original = String(raw == null ? '' : raw).trim();
  if (!original) return { empty: true };

  let s = normalizeUnitsText(original);
  s = s.replace(/^[=≈~]\s*/, '');
  s = normalizeNumberText(s);
  s = s.replace(/^[^0-9+\-]*?(?=[-+]?\d)/, '');

  const numMatch = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/.exec(s);
  if (!numMatch) {
    return { original: original, numeric: false, text: s };
  }
  const value = Number(numMatch[0]);
  const restRaw = s.slice(numMatch[0].length).trim();
  const unitText = restRaw.replace(/^[\\\s]*/, '');
  const unit = parseUnitExpr(unitText);
  if (unit.error) {
    return {
      original: original, numeric: Number.isFinite(value), value: value,
      unitText: unitText, unitError: unit.error, unitToken: unit.token || '',
      knownUnit: false
    };
  }
  return {
    original: original,
    numeric: Number.isFinite(value),
    value: value,
    unitText: unitText,
    unitScale: unit.factor,
    unitDim: unit.dim,
    hasUnit: !!unitText.trim(),
    knownUnit: true
  };
}

/* 有效数字：统计数值字面量的有效位数（不含前导零） */
function significantDigits(literal) {
  let s = String(literal || '').trim().replace(/^[-+]/, '');
  if (!s) return 0;
  s = s.replace(/[eE].*$/, '');
  s = s.replace(/\./g, '');
  s = s.replace(/^0+/, '');
  if (!s) return 0;
  return s.length;
}

function numericLiteralOf(raw) {
  const s = normalizeNumberText(normalizeUnitsText(raw));
  const m = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/.exec(String(s).trim());
  return m ? m[0] : '';
}

function roundSig(value, sig) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return 0;
  const mag = Math.floor(Math.log10(Math.abs(n)));
  const step = Math.pow(10, mag - (sig - 1));
  return Math.round(n / step) * step;
}

/**
 * 机器可判的物理答案比对。
 *
 * @param {string} userAns 学生答案（"72 km/h"、"1.6e-19 J"、"3v_0/(2L)"）
 * @param {string} refAns 标准答案
 * @param {object} meta 题目的 physicsMeta：{ answerType, unit, dimension, tolRel, sigFigs }
 * @returns {{ok:boolean, verdict:string, detail:string, ...}}
 *   verdict: correct | valueOff | dimensionMismatch | unitUnknown | unitMissing | deferred
 */
function checkAnswer(userAns, refAns, meta) {
  const m = meta || {};
  const tolRel = Number.isFinite(Number(m.tolRel)) ? Math.abs(Number(m.tolRel)) : 0.02;
  const answerType = String(m.answerType || '');
  const userRaw = String(userAns == null ? '' : userAns).trim();
  const refRaw = String(refAns == null ? '' : refAns).trim();

  if (!userRaw) return { ok: false, verdict: 'deferred', detail: '没有可判的作答内容', deferred: true };

  const refQ = parseQuantity(refRaw);
  const userQ = parseQuantity(userRaw);

  /* 纯符号题（答案含变量或 LaTeX 命令）：数值管线不适用，
     直接走符号等价；判不了就降级给 AI，绝不拿「单位看不懂」误伤。 */
  const refHasSymbol = /\\[a-zA-Z]+|[a-zA-Z]/.test(refRaw.replace(/\\times|\\cdot|\\left|\\right|\\mathrm|\\text|\\frac|\\sqrt/g, ''));
  /* 「带数字但单位写法不认识」属于单位问题，不是符号题：别把它推进符号分支 */
  const refNumericBadUnit = refQ.numeric && refQ.knownUnit === false;
  if (answerType === 'symbolic' || answerType === 'proof' || answerType === 'choice' ||
      (refHasSymbol && !refNumericBadUnit && !(refQ.numeric && refQ.knownUnit !== false))) {
    const ok = safeSymbolicEqual(userRaw, refRaw);
    return ok
      ? { ok: true, verdict: 'correct', detail: '符号表达式与标准答案等价', mode: 'symbolic' }
      : { ok: false, verdict: 'deferred', detail: '标准答案不是数值型，需按符号或推导过程评判', deferred: true, mode: 'symbolic' };
  }

  /* 标准答案不是「数值 + 单位」：只能走符号等价，交给数学层 */
  if (!refQ.numeric) {
    const ok = safeSymbolicEqual(userRaw, refRaw);
    return ok
      ? { ok: true, verdict: 'correct', detail: '符号表达式与标准答案等价', mode: 'symbolic' }
      : { ok: false, verdict: 'deferred', detail: '标准答案不是数值型，需按符号或推导过程评判', deferred: true, mode: 'symbolic' };
  }

  /* 学生给的是符号表达式（含字母变量），但标准答案是数值 → 无法直接比数 */
  if (!userQ.numeric) {
    const ok = safeSymbolicEqual(userRaw, refRaw);
    if (ok) return { ok: true, verdict: 'correct', detail: '与标准答案等价', mode: 'symbolic' };
    return { ok: false, verdict: 'deferred', detail: '作答不是数值，需按推导过程评判', deferred: true, mode: 'symbolic' };
  }

  const detail = [];
  /* ---- 单位解析失败：不判错，先说清楚单位没看懂 ---- */
  if (userQ.knownUnit === false) {
    return {
      ok: false,
      verdict: 'unitUnknown',
      detail: '单位「' + (userQ.unitText || userQ.unitToken || '') + '」无法识别。常用写法：m/s、m/s^2、N·m、J、eV、km/h',
      mode: 'numeric_unit'
    };
  }

  /* 期望单位：优先题目声明的 unit，其次标准答案自带的单位 */
  const refUnitText = refQ.hasUnit ? refQ.unitText : String(m.unit || '');
  const refUnit = refUnitText ? parseUnitExpr(refUnitText) : { factor: 1, dim: zeros(), empty: true };
  if (refUnit.error) {
    return { ok: false, verdict: 'deferred', detail: '标准答案单位配置无法解析：' + (m.unit || refQ.unitText), deferred: true };
  }

  const expectedDim = Array.isArray(m.dimension) && m.dimension.length === 7
    ? m.dimension.map(Number)
    : (refUnit.empty ? null : refUnit.dim);

  /* ---- 学生没写单位：按标准单位理解，只提示不判错 ---- */
  let userScale = 1;
  let userDim = zeros();
  let missingUnit = false;
  if (!userQ.hasUnit) {
    missingUnit = true;
    userScale = refUnit.empty ? 1 : refUnit.factor;
    userDim = expectedDim ? expectedDim.slice() : zeros();
  } else {
    userScale = userQ.unitScale;
    userDim = userQ.unitDim;
  }

  /* ---- 第一层：量纲一致性 ---- */
  if (expectedDim && !sameVec(userDim, expectedDim)) {
    detail.push('你的单位量纲是 ' + describeDim(userDim) + '（' + formatDim(userDim) + '），'
      + '标准答案是 ' + describeDim(expectedDim) + '（' + formatDim(expectedDim) + '）');
    return {
      ok: false,
      verdict: 'dimensionMismatch',
      detail: '量纲不一致：' + detail.join('；') + '。先检查公式，再检查单位换算。',
      mode: 'numeric_unit',
      userDim: userDim,
      expectedDim: expectedDim
    };
  }

  /* ---- 第二层：换算到 SI 后比数 ---- */
  const userSI = userQ.value * userScale;
  const refValue = refQ.hasUnit
    ? refQ.value * refQ.unitScale
    : (refUnit.empty ? refQ.value : refQ.value * refUnit.factor);
  const denom = Math.max(Math.abs(refValue), 1e-12);
  const relErr = Math.abs(userSI - refValue) / denom;
  const tol = Math.max(tolRel, 0);
  /* 边界包含：2.04 vs 2 在 2% 容差下应判对（浮点会把 0.02 算成 0.020000000000000018） */
  const ok = relErr <= tol * (1 + 1e-9);

  const warnings = [];
  if (missingUnit && !refUnit.empty) warnings.push('没写单位，已按 ' + (refUnitText || 'SI 单位') + ' 理解');

  /* 有效数字提示：只在数值判对时给，避免与「算错」混在一起 */
  const sig = Number(m.sigFigs);
  if (ok && Number.isFinite(sig) && sig > 0) {
    const digits = significantDigits(numericLiteralOf(userRaw));
    if (digits && Math.abs(digits - sig) > 1) {
      warnings.push('有效数字 ' + digits + ' 位，题目建议 ' + sig + ' 位');
    }
  }

  const converted = describeConversion(userQ, userScale, refUnit);
  const summary = ok
    ? '数值一致（相对误差 ' + (relErr * 100).toFixed(2) + '% ≤ 允许 ' + (tol * 100).toFixed(2) + '%）'
    : '数值不符：你的是 ' + fmtNum(userSI) + '，标准值 ' + fmtNum(refValue)
      + '，相对误差 ' + (relErr * 100).toFixed(2) + '%（允许 ' + (tol * 100).toFixed(2) + '%）';

  return {
    ok: ok,
    verdict: ok ? 'correct' : 'valueOff',
    detail: ['量纲一致（' + describeDim(expectedDim || userDim) + '）', converted, summary].filter(Boolean).join('；'),
    mode: 'numeric_unit',
    relErr: Number(relErr.toFixed(6)),
    tolRel: tol,
    userSI: userSI,
    refSI: refValue,
    warnings: warnings,
    answerType: answerType || (refQ.hasUnit ? 'numeric_unit' : 'numeric')
  };
}

function describeConversion(userQ, userScale, refUnit) {
  if (!userQ.hasUnit) return '';
  const u = userQ.unitText;
  if (!u) return '';
  const same = refUnit && !refUnit.empty && Math.abs(userScale - refUnit.factor) < 1e-18;
  if (same) return u + ' 已是标准单位';
  return u + ' → 标准单位 ×' + fmtNum(userScale);
}

function fmtNum(x) {
  if (!Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return x.toExponential(3).replace(/e([+-])(\d)$/, 'e$10$2');
  return String(Math.round(x * 1e6) / 1e6);
}

/* 物理常见同义符号归一化后再交给 math-equiv */
function canonSymbols(s) {
  return String(s || '')
    .replace(/\\varepsilon/g, '\\epsilon')
    .replace(/\\varphi/g, '\\phi')
    .replace(/\\upsilon/g, 'v')
    .replace(/\\ell\b/g, 'l')
    .replace(/\\mathrm\{d\}/g, 'd')
    .replace(/\\text\{([^{}]*)\}/g, '$1');
}

function safeSymbolicEqual(a, b) {
  try {
    return !!isMathEquivalent(canonSymbols(a), canonSymbols(b)).ok;
  } catch (e) {
    return false;
  }
}

/**
 * 是否值得交给机器判：数值填空题 + 单位可解析 → 直接判；其余交给 AI。
 * 组卷/提交接口据此决定要不要消耗 LLM 额度。
 */
function canAutoJudge(problem) {
  const meta = (problem && problem.physicsMeta) || {};
  const type = String(meta.answerType || '');
  if (type === 'numeric_unit' || type === 'numeric') return true;
  if (type === 'symbolic') return false;
  const ans = String((problem && problem.answer) || '');
  const q = parseQuantity(ans);
  return !!(q.numeric && (q.hasUnit || meta.unit));
}

module.exports = {
  BASE_KEYS: BASE_KEYS,
  UNITS: UNITS,
  PREFIXES: PREFIXES,
  parseUnitExpr: parseUnitExpr,
  parseQuantity: parseQuantity,
  resolveUnitSymbol: resolveUnitSymbol,
  checkAnswer: checkAnswer,
  canAutoJudge: canAutoJudge,
  formatDim: formatDim,
  describeDim: describeDim,
  sameVec: sameVec,
  significantDigits: significantDigits,
  roundSig: roundSig
};
