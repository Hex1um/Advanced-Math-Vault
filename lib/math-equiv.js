/**
 * 零依赖安全 LaTeX / 数学表达式数值等价判定引擎
 *
 * 为什么需要它：`canonAnswer` 是字符串规范化，遇到高数里最常见的「形式不同但数学等价」
 * 就会误杀 —— 半角公式、对数合并、不定积分差常数 C 都是这样。判题每次调 LLM 太慢，
 * 调 SymPy 又要破坏 Node 单进程零依赖部署，所以在 JS 里做数值采样比对。
 *
 * 安全性：不使用 eval / new Function，只把表达式解析成 JSON AST 后递归求值，
 * 因此即使答案里塞了任意 JS 也只会得到「解析失败」。
 *
 * 判等策略：
 *   - 默认：若干随机采样点上两式数值差都落在相对容差内 → 等价；
 *   - allowConstantOffset（不定积分）：只要求「差值恒定」，即任意常数差异不算错。
 */
'use strict';

const CONSTANTS = {
  pi: Math.PI,
  e: Math.E,
};

const FUNCTIONS = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  cot: (x) => 1 / Math.tan(x),
  sec: (x) => 1 / Math.cos(x),
  csc: (x) => 1 / Math.sin(x),
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  ln: (x) => Math.log(Math.abs(x)), // 兼容高数不定积分里 ln|...| 的写法
  log: (x) => Math.log(Math.abs(x)),
  lg: (x) => Math.log10(Math.abs(x)),
  exp: Math.exp,
  sqrt: Math.sqrt,
  abs: Math.abs,
  sgn: Math.sign,
};

const FN_NAMES = Object.keys(FUNCTIONS).join('|');

/* 输入护栏：这个引擎直接吃**用户提交的答案**，而且用的是递归下降 + 递归求值。
   几千层 `(((((...` 或几万个 token 足以把调用栈打爆（RangeError 一路冒到 HTTP 层变成 500）。
   两个上限都远高于任何真实答案：最长的积分答案也就百来字符、嵌套不到 10 层。 */
const MAX_INPUT_LEN = 2000;
const MAX_DEPTH = 64;

/** 将常见 LaTeX 语法清洗为标准中缀表达式 */
function normalizeLatex(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';

  // 去掉外层 $ / $$ 与末尾 +C / + C / +C_1
  s = s.replace(/^\$+|\$+$/g, '').trim();
  s = s.replace(/^\$\$+|\$\$+$/g, '').trim();
  s = s.replace(/\s*\+\s*C\s*$/i, '').trim();
  s = s.replace(/\s*\+\s*C_?\d\s*$/i, '').trim();

  s = s
    .replace(/\\left\s*|\\right\s*/g, '')
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\\quad|\\qquad|\\displaystyle|\\limits|\\nolimits/g, ' ')
    .replace(/\\dfrac|\\tfrac/g, '\\frac')
    .replace(/\\cdot|\\times/g, '*')
    .replace(/\\div/g, '/')
    .replace(/\\pi\b/g, 'pi')
    .replace(/\\mathrm\{e\}/g, 'e')
    .replace(/\\mathrm\{d\}/g, ' ')
    .replace(/\\operatorname\{(arcsin|arccos|arctan|sin|cos|tan|cot|sec|csc|ln|log|exp|sqrt)\}/g, '$1')
    .replace(new RegExp('\\\\(' + FN_NAMES + ')\\b', 'g'), ' $1 ')
    .replace(/\\(arcsin|arccos|arctan|sin|cos|tan|cot|sec|csc|ln|log|lg|exp|sqrt|sinh|cosh|tanh)\b/g, '$1')
    .replace(/\|([^|]+)\|/g, 'abs($1)')
    .replace(/\\%|%/g, ' ')
    .replace(/\\infty/g, '1e309');

  // 递归展开 \frac{a}{b} -> ((a)/(b))，支持嵌套
  const fracRe = /\\frac\{([^{}]*)\}\{([^{}]*)\}/;
  let guard = 0;
  while (fracRe.test(s) && guard++ < 30) {
    s = s.replace(fracRe, '(($1)/($2))');
  }
  // 单字符参数写法 \frac12 -> ((1)/(2))
  s = s.replace(/\\frac(\d)(\d)/g, '(($1)/($2))');

  // 幂的括号写法 x^{2} / \sin^{2}
  s = s.replace(/\^\s*\{([^{}]*)\}/g, '^($1)');

  // 替换花括号为圆括号
  s = s.replace(/\{/g, '(').replace(/\}/g, ')');
  // 全角符号
  s = s.replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/[×·]/g, '*').replace(/[÷]/g, '/');
  return s;
}

function tokenize(expr) {
  if (!expr) return null;
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z]+)|([+\-*/^()]))/g;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(expr)) !== null) {
    if (m.index !== lastIndex) return null; // 存在非法字符
    lastIndex = re.lastIndex;
    if (m[1]) tokens.push({ type: 'num', val: Number(m[1]) });
    else if (m[2]) tokens.push({ type: 'id', val: m[2] });
    else tokens.push({ type: 'op', val: m[3] });
  }
  if (lastIndex !== expr.length) return null;
  if (!tokens.length) return null;

  // 补全隐式乘法：2x、2(x+1)、(x)(y)、x sin(x)
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const cur = tokens[i];
    const prev = out[out.length - 1];
    if (prev) {
      const prevEndsAtom =
        prev.type === 'num' ||
        (prev.type === 'id' && !FUNCTIONS[prev.val]) ||
        (prev.type === 'op' && prev.val === ')');
      const curStartsAtom =
        cur.type === 'id' || cur.type === 'num' || (cur.type === 'op' && cur.val === '(');
      if (prevEndsAtom && curStartsAtom) out.push({ type: 'op', val: '*', implicit: true });
    }
    out.push(cur);
  }
  return out;
}

/** 递归下降解析为安全 AST */
function parse(tokens) {
  let pos = 0;
  /* 嵌套深度用显式计数而不是靠栈溢出兜底：RangeError 的 message 不可控，
     而我们要把「太深」和「语法错」分开报，前者是攻击/脏数据，后者是学生写错了。 */
  let depth = 0;
  function enter() {
    if (++depth > MAX_DEPTH) throw new Error('表达式嵌套过深');
  }
  function leave() { depth--; }
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  function parseExpr() {
    let node = parseTerm();
    while (peek() && peek().type === 'op' && (peek().val === '+' || peek().val === '-')) {
      const op = consume().val;
      node = { type: 'bin', op, left: node, right: parseTerm() };
    }
    return node;
  }

  function parseTerm() {
    let node = parseImplicit();
    while (peek() && peek().type === 'op' && (peek().val === '*' || peek().val === '/') && !peek().implicit) {
      const op = consume().val;
      node = { type: 'bin', op, left: node, right: parseImplicit() };
    }
    return node;
  }

  /* 隐式乘法优先级高于显式乘除：`1/2x` 读作 1/(2x)，`2x y` 读作 (2x)·y。
     这样 `\frac{1}{2}\sin 2x` 与 `\sin x\cos x` 才能落到同一个 AST 结构上。 */
  function parseImplicit() {
    let node = parseUnary();
    while (peek() && peek().type === 'op' && peek().val === '*' && peek().implicit) {
      consume();
      node = { type: 'bin', op: '*', left: node, right: parseUnary() };
    }
    return node;
  }

  function parseUnary() {
    if (peek() && peek().type === 'op' && (peek().val === '+' || peek().val === '-')) {
      const op = consume().val;
      /* `-----x` 这种连续一元号也是一层一层递归的，同样要计数 */
      enter();
      try { return { type: 'unary', op, arg: parseUnary() }; }
      finally { leave(); }
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    if (peek() && peek().type === 'op' && peek().val === '^') {
      consume();
      return { type: 'bin', op: '^', left: base, right: parseUnary() };
    }
    return base;
  }

  /* 每进一次 primary 记一层：括号、函数调用参数都由它下钻，深度与输入里的
     `(` / `\sin(` 个数成正比。负数（`--x`）在 parseUnary 里另计。 */
  function parsePrimary() {
    enter();
    try { return parsePrimaryInner(); }
    finally { leave(); }
  }

  function parsePrimaryInner() {
    const t = peek();
    if (!t) throw new Error('Unexpected EOF');
    if (t.type === 'num') {
      consume();
      return { type: 'num', val: t.val };
    }
    if (t.type === 'id') {
      consume();
      if (FUNCTIONS[t.val]) {
        let arg;
        if (peek() && peek().type === 'op' && peek().val === '(') {
          consume();
          arg = parseExpr();
          if (!peek() || peek().val !== ')') throw new Error('Missing )');
          consume();
        } else if (peek() && peek().type === 'op' && peek().val === '^') {
          // \sin^2 x：先把幂算完再当函数参数
          consume();
          const power = parseUnary();
          const inner = parseUnary();
          arg = { type: 'bin', op: '^', left: { type: 'call', fn: t.val, arg: inner }, right: power };
          return arg;
        } else {
          arg = parseUnary();
          /* sin 2x / ln 2x：数字开头的隐式乘积整体作为参数；sin x cos x 则只取 x，
             后面的 cos 留给上层的乘法链，符合高数书写习惯。 */
          while (
            peek() && peek().type === 'op' && peek().val === '*' && peek().implicit &&
            arg.type === 'num' && tokens[pos + 1] && (tokens[pos + 1].type === 'id' || tokens[pos + 1].type === 'num')
          ) {
            consume();
            arg = { type: 'bin', op: '*', left: arg, right: parseUnary() };
          }
        }
        return { type: 'call', fn: t.val, arg };
      }
      return { type: 'var', name: t.val };
    }
    if (t.type === 'op' && t.val === '(') {
      consume();
      const node = parseExpr();
      if (!peek() || peek().val !== ')') throw new Error('Missing )');
      consume();
      return node;
    }
    throw new Error('Unexpected token: ' + t.val);
  }

  const ast = parseExpr();
  if (pos !== tokens.length) throw new Error('Trailing tokens');
  return ast;
}

function evalAst(node, env) {
  switch (node.type) {
    case 'num': return node.val;
    case 'var':
      if (node.name in env) return env[node.name];
      if (node.name in CONSTANTS) return CONSTANTS[node.name];
      throw new Error('Unknown var: ' + node.name);
    case 'unary': return node.op === '-' ? -evalAst(node.arg, env) : evalAst(node.arg, env);
    case 'call': {
      const fn = FUNCTIONS[node.fn];
      return fn(evalAst(node.arg, env));
    }
    case 'bin': {
      const l = evalAst(node.left, env);
      const r = evalAst(node.right, env);
      if (node.op === '+') return l + r;
      if (node.op === '-') return l - r;
      if (node.op === '*') return l * r;
      if (node.op === '/') return l / r;
      if (node.op === '^') return Math.pow(l, r);
      return NaN;
    }
    default: return NaN;
  }
}

function collectVars(node, set = new Set()) {
  if (!node) return set;
  if (node.type === 'var' && !(node.name in CONSTANTS)) set.add(node.name);
  if (node.left) collectVars(node.left, set);
  if (node.right) collectVars(node.right, set);
  if (node.arg) collectVars(node.arg, set);
  return set;
}

/** 把表达式编译成可求值函数；失败返回 null（长度/深度超限时返回 { error }） */
function compile(raw) {
  const src = String(raw == null ? '' : raw);
  if (src.length > MAX_INPUT_LEN) return { error: 'too_long' };
  try {
    const tokens = tokenize(normalizeLatex(src));
    if (!tokens) return null;
    const ast = parse(tokens);
    return { ast, vars: [...collectVars(ast)] };
  } catch (e) {
    if (/嵌套过深/.test(String(e && e.message))) return { error: 'too_deep' };
    return null;
  }
}

/**
 * 判断两个数学表达式是否数值等价
 * @param {string} userRaw 用户答案
 * @param {string} refRaw 标准答案
 * @param {object} opts { allowConstantOffset?: boolean, samples?: number, tol?: number }
 */
function isMathEquivalent(userRaw, refRaw, opts = {}) {
  const { allowConstantOffset = false, samples = 16, tol = 1e-6 } = opts;
  const a = compile(userRaw);
  const b = compile(refRaw);
  /* 长度/深度超限单独报，不混进「解析失败」：调用方要能区分「学生写错」和
     「有人在打解析器」，后者不需要重试也不需要 AI 兜底。 */
  if (a && a.error) return { ok: false, reason: a.error };
  if (b && b.error) return { ok: false, reason: b.error };
  if (!a || !b) return { ok: false, reason: !a ? 'parse_user_failed' : 'parse_ref_failed' };

  const vars = [...new Set([...a.vars, ...b.vars])];
  if (vars.length > 4) return { ok: false, reason: 'too_many_vars' };

  // 固定种子，确保同一对表达式结论稳定（CI 可复现）
  let seed = 20261126;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return ((seed / 0xffffffff) * 2 - 1) * 2.2; // [-2.2, 2.2]
  };

  const diffs = [];
  let valid = 0;
  for (let i = 0; i < samples * 4 && valid < samples; i++) {
    const env = {};
    for (const v of vars) env[v] = rand();
    let v1, v2;
    try {
      v1 = evalAst(a.ast, env);
      v2 = evalAst(b.ast, env);
    } catch (e) { continue; }
    if (!Number.isFinite(v1) || !Number.isFinite(v2)) continue;
    if (Math.abs(v1) > 1e12 || Math.abs(v2) > 1e12) continue;
    valid++;
    diffs.push(v1 - v2);
  }

  if (valid < Math.min(6, samples)) return { ok: false, reason: 'insufficient_domain_points' };

  const scaleOf = (d) => Math.max(1, Math.abs(d));
  if (allowConstantOffset) {
    /* 不定积分的两条原函数只差常数。取差值中位数作为「常数偏移」，
       再看有多少采样点落在这个偏移附近：靠近原函数奇点/零点相消的点会产生
       数值噪声（sec+tan 在 ±π/2 附近尤其明显），因此允许少量离群点。 */
    const sorted = diffs.slice().sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)];
    const limit = Math.max(1e-6, 1e-3 * scaleOf(median));
    const inliers = diffs.filter((d) => Math.abs(d - median) <= limit).length;
    const ratio = inliers / diffs.length;
    const maxDev = Math.max(...diffs.map((d) => Math.abs(d - median)));
    return { ok: ratio >= 0.85, mode: 'up_to_constant', maxDev, offset: median, inlierRatio: Number(ratio.toFixed(3)) };
  }

  const worst = Math.max(...diffs.map((d, i) => Math.abs(d) / scaleOf(diffs[i])));
  return { ok: worst < tol, mode: 'exact_numeric', maxErr: worst };
}

module.exports = { isMathEquivalent, normalizeLatex, compile };
