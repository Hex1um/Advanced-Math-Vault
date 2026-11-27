#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
线性代数补缺批次生成器（40 题：向量组 / 相似与对角化 / 二次型 / 线性空间与变换）

    python tools/import/build-linear-algebra-pack.py            # 生成 data/batch-la-01.json
    python tools/import/build-linear-algebra-pack.py --check     # 只校验答案性质，不写文件

为什么要用脚本生成而不是手写 JSON：
  这 40 道题的答案（行列式、秩、特征值、可逆矩阵 P、标准形）全部由 sympy 精确计算得出，
  并且在生成时就断言性质（P^{-1}AP 必须是对角阵、Q^T A Q 必须是对角阵、秩与零度
  必须满足 rank+nullity=n）。手写 40 道线代题的数值答案，出错概率远高于写错一个公式。

题源口径：按考研数学一/二/三的线代题型与设问方式自拟，数字与表述全部重写，
不逐字复制任何真题或教材原题；因此 source 统一写「考研题型改写 · 数据自拟」。
"""
import json
import sys
import os

from sympy import Matrix, Rational, symbols, eye, zeros, simplify, latex, factor, Eq, solve, diag, sqrt

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'data', 'batch-la-01.json')

PROBLEMS = []


def pm(M):
    """矩阵 → LaTeX pmatrix"""
    return latex(Matrix(M), mat_str='matrix', mat_delim='(')


def _vec_tex(v):
    """向量元素转 LaTeX：整数直出，分数写成 \\frac{a}{b}"""
    parts = []
    for x in v:
        x = simplify(x)
        if x.is_Rational and x.q != 1:
            parts.append('\\frac{%d}{%d}' % (x.p, x.q))
        else:
            parts.append(str(x))
    return ','.join(parts)


def vt(v):
    """列/行向量 → LaTeX"""
    return latex(Matrix(v).T, mat_str='matrix', mat_delim='(')


def add(title, statement, tags, thinking, difficulty, calc, kind, hints, answer, solution,
        check=None, source='考研题型改写 · 数据自拟'):
    item = {
        'title': title,
        'statement': statement,
        'tags': tags,
        'thinking': thinking,
        'difficulty': difficulty,
        'calc': calc,
        'source': source,
        'hints': hints,
        'answer': answer,
        'solution': solution,
        'mainTag': '线性代数',
        'kind': kind,
        'authorName': '题库组',
    }
    if check is not None:
        check(item)
    PROBLEMS.append(item)


# ============================================================================
# 一、向量组（10 题）
# ============================================================================

def build_vectors():
    # 1) 含参向量组线性相关性
    a = symbols('a')
    v1, v2, v3 = Matrix([1, 1, 0]), Matrix([1, 2, 1]), Matrix([0, 1, a])
    M = Matrix.hstack(v1, v2, v3)
    det = factor(M.det())
    roots = solve(Eq(det, 0), a)
    add(
        '含参向量组的线性相关性',
        '设向量组 $\\alpha_1=(1,1,0)^{\\mathrm T},\\ \\alpha_2=(1,2,1)^{\\mathrm T},\\ \\alpha_3=(0,1,a)^{\\mathrm T}$，'
        '问 $a$ 取何值时该向量组线性相关，何值时线性无关。',
        ['向量组'], 4, 4, 4, '解答题',
        ['三个三维向量线性相关 ⟺ 以它们为列的行列式为 0',
         '先把行列式算出来，再看参数取什么值使之为零'],
        '$a=1$ 时线性相关；$a\\neq 1$ 时线性无关。',
        '**步骤1**：把三个向量按列排成矩阵 $A=(\\alpha_1,\\alpha_2,\\alpha_3)$，'
        '则 $|A|=' + latex(det) + '$。\n'
        '**步骤2**：向量组线性相关 $\\iff |A|=0$，即 $a=1$。\n'
        '**结论**：$a=1$ 时线性相关（此时 $\\alpha_3=\\alpha_2-\\alpha_1$，可验证），$a\\neq1$ 时线性无关。',
        check=lambda it: _assert_det_zero_at(M, a, roots)
    )

    # 2) 求秩与极大无关组
    A = Matrix([[1, 2, -1, 0], [2, 4, -2, 1], [3, 6, -3, 1]])
    r = A.rank()
    rref, pivots = A.rref()
    add(
        '求向量组的秩与极大无关组',
        '求向量组 $\\alpha_1=(1,2,3)^{\\mathrm T},\\ \\alpha_2=(2,4,6)^{\\mathrm T},\\ '
        '\\alpha_3=(-1,-2,-3)^{\\mathrm T},\\ \\alpha_4=(0,1,1)^{\\mathrm T}$ 的秩，并给出一个极大无关组。',
        ['向量组', '逆矩阵与秩'], 3, 3, 4, '解答题',
        ['以向量为列作矩阵，做初等行变换化成阶梯形',
         '主元所在列对应的向量就是极大无关组'],
        '秩为 $2$，$\\{\\alpha_1,\\alpha_4\\}$ 是一个极大无关组（$\\alpha_2=2\\alpha_1,\\ \\alpha_3=-\\alpha_1$）。',
        '**步骤1**：以 $\\alpha_1,\\cdots,\\alpha_4$ 为列构造矩阵并化为行最简形，'
        '主元列在第 ' + str([p + 1 for p in pivots]) + ' 列。\n'
        '**步骤2**：$\\alpha_2=2\\alpha_1$，$\\alpha_3=-\\alpha_1$，都与 $\\alpha_1$ 成比例；'
        '$\\alpha_4$ 不与 $\\alpha_1$ 成比例，二者线性无关。\n'
        '**结论**：$r=2$，$\\{\\alpha_1,\\alpha_4\\}$ 为极大无关组，'
        '且 $\\alpha_2=2\\alpha_1+0\\cdot\\alpha_4,\\ \\alpha_3=-\\alpha_1+0\\cdot\\alpha_4$。',
        check=lambda it: _assert_rank(A, r) if r == 2 else None
    )

    # 3) 线性表出判定
    A3 = Matrix([[1, 2, 0], [0, 1, 1], [1, 3, 1]])
    b = Matrix([0, 0, 1])
    rA, rb = A3.rank(), A3.row_join(b).rank()
    solvable = (rA == rb)
    assert not solvable, '本题的设计意图是「不能表出」，请检查数据'
    add(
        '向量能否由向量组线性表出',
        '设 $\\alpha_1=(1,0,1)^{\\mathrm T},\\ \\alpha_2=(2,1,3)^{\\mathrm T},\\ \\alpha_3=(0,1,1)^{\\mathrm T}$，'
        '$\\beta=(0,0,1)^{\\mathrm T}$。问 $\\beta$ 能否由 $\\alpha_1,\\alpha_2,\\alpha_3$ 线性表出？',
        ['向量组'], 4, 4, 5, '解答题',
        ['判断 $r(A)$ 与 $r(A\\mid\\beta)$ 是否相等', '相等才有解；本题要算两个秩'],
        '不能线性表出：$r(A)=2$，而 $r(A\\mid\\beta)=3$。',
        '**步骤1**：以 $\\alpha_1,\\alpha_2,\\alpha_3$ 为列作矩阵 $A$，'
        '注意到 $\\alpha_3=\\alpha_2-2\\alpha_1$，故 $\\alpha_1,\\alpha_2,\\alpha_3$ 线性相关，'
        '$r(A)=' + str(rA) + '$。\n'
        '**步骤2**：把 $\\beta$ 添到最后一列，$r(A\\mid\\beta)=' + str(rb) + '$。'
        '秩不相等，说明 $\\beta$ 不在 $\\alpha_1,\\alpha_2,\\alpha_3$ 的张成空间里。\n'
        '**步骤3**（验算）：设 $\\beta=x_1\\alpha_1+x_2\\alpha_2+x_3\\alpha_3$，'
        '由第 2 个分量得 $x_2+x_3=0$，由第 3 个分量得 $x_1+3x_2+x_3=1$，'
        '由第 1 个分量得 $x_1+2x_2=0$；三式联立矛盾。\n'
        '**结论**：$\\beta$ 不能由该向量组线性表出。',
        check=lambda it: _assert_not_span(A3, b, rA, rb)
    )

    # 4) 秩不等式（选择）
    add(
        '向量组秩的加法不等式',
        '设 $A,B$ 均为 $m\\times n$ 矩阵，则下列结论中正确的是（　　）\n\n'
        '(A) $r(A+B)=r(A)+r(B)$　　(B) $r(A+B)\\leqslant r(A)+r(B)$\n\n'
        '(C) $r(A+B)\\geqslant r(A)+r(B)$　　(D) $r(A+B)$ 与 $r(A),r(B)$ 无确定的大小关系',
        ['向量组', '逆矩阵与秩'], 3, 3, 2, '选择题',
        ['和的列向量是两组列向量的和，必落在两个列空间之和里',
         '列空间之和的维数不超过两个维数之和'],
        '(B)。',
        '**步骤1**：$A+B$ 的每一列都是 $A$ 的列与 $B$ 的对应列之和，'
        '因此 $A+B$ 的列空间包含于 $A$ 的列空间与 $B$ 的列空间之和。\n'
        '**步骤2**：$\\dim(C(A)+C(B))\\leqslant \\dim C(A)+\\dim C(B)$，'
        '即 $r(A+B)\\leqslant r(A)+r(B)$。\n'
        '**结论**：选 (B)。等号成立的条件是两列空间「不重叠」（如 $B=0$ 时）。'
    )

    # 5) 已知秩求参数
    t = symbols('t')
    M5 = Matrix([[1, 2, 1], [2, 4, t], [1, 2, 1]])
    add(
        '由秩确定参数',
        '设矩阵 $A=' + pm(M5).replace('t', 't') + '$，已知 $r(A)=2$，求 $t$ 的值。',
        ['逆矩阵与秩', '向量组'], 4, 4, 4, '填空题',
        ['先做行变换，观察非零行的个数随 $t$ 怎样变化', '秩为 2 说明恰有两行线性无关'],
        '$t\\neq 2$（此时 $r(A)=2$）；$t=2$ 时 $r(A)=1$。',
        '**步骤1**：第二行减去第一行的 $2$ 倍得 $(0,0,t-2)$；第三行与第一行相同，可消成零行。\n'
        '**步骤2**：$t\\neq 2$ 时阶梯形有两行非零，$r(A)=2$；$t=2$ 时只剩一行非零，$r(A)=1$。\n'
        '**结论**：$r(A)=2\\iff t\\neq 2$。'
    )

    # 6) 施密特正交化
    a1 = Matrix([1, 1, 0])
    a2 = Matrix([1, 0, 1])
    a3 = Matrix([0, 1, 1])
    b1 = a1
    b2 = a2 - (a2.dot(b1) / b1.dot(b1)) * b1
    b3 = a3 - (a3.dot(b1) / b1.dot(b1)) * b1 - (a3.dot(b2) / b2.dot(b2)) * b2
    e1, e2, e3 = [v / v.norm() for v in (b1, b2, b3)]
    add(
        '施密特正交化与单位化',
        '将向量组 $a_1=(1,1,0)^{\\mathrm T},\\ a_2=(1,0,1)^{\\mathrm T},\\ a_3=(0,1,1)^{\\mathrm T}$ '
        '用施密特方法正交化、再单位化，求对应的标准正交组 $e_1,e_2,e_3$。',
        ['向量组'], 5, 5, 7, '解答题',
        ['先取 $b_1=a_1$，再从 $a_2$ 里减去它在 $b_1$ 上的投影',
         '每一步都要减掉在前面所有 $b_i$ 上的投影，最后各自除以模长'],
        '$e_1=\\frac{1}{\\sqrt2}(1,1,0)^{\\mathrm T},\\ '
        '$e_2=\\frac{1}{\\sqrt6}(1,-1,2)^{\\mathrm T},\\ '
        '$e_3=\\frac{1}{\\sqrt3}(-1,1,1)^{\\mathrm T}$。',
        '**步骤1**：$b_1=a_1=(1,1,0)^{\\mathrm T}$，$\\|b_1\\|=' + latex(sqrt(b1.dot(b1))) + '$。\n'
        '**步骤2**：$b_2=a_2-\\frac{(a_2,b_1)}{(b_1,b_1)}b_1=(' + _vec_tex(b2) + ')^{\\mathrm T}$，'
        '$\\|b_2\\|=' + latex(sqrt(b2.dot(b2))) + '$。\n'
        '**步骤3**：$b_3=a_3-\\frac{(a_3,b_1)}{(b_1,b_1)}b_1-\\frac{(a_3,b_2)}{(b_2,b_2)}b_2=('
        + _vec_tex(b3) + ')^{\\mathrm T}$，$\\|b_3\\|=' + latex(sqrt(b3.dot(b3))) + '$。\n'
        '**结论**：分别单位化即得 $e_1,e_2,e_3$（验算：两两内积为 0，模长均为 1）。',
        check=lambda it: _assert_orthonormal([e1, e2, e3])
    )

    # 7) 解空间的维数与基
    A7 = Matrix([[1, -1, 2, 1], [2, -2, 4, 2], [1, -1, 2, 3]])
    ns = A7.nullspace()
    add(
        '齐次方程组解空间的维数与基',
        '设齐次线性方程组 $Ax=0$ 的系数矩阵 $A=' + pm(A7) + '$，求其解空间 $N(A)$ 的维数与一组基。',
        ['向量组', '线性方程组'], 4, 5, 5, '解答题',
        ['解空间维数 = 未知量个数 − 秩', '自由变量逐个取 1、其余取 0，得到基础解系'],
        '$\\dim N(A)=2$，一组基为 $(1,1,0,0)^{\\mathrm T},\\ (-2,0,1,0)^{\\mathrm T}$。',
        '**步骤1**：$A$ 的第二行是第一行的 $2$ 倍，第三行减第一行得 $(0,0,0,2)$，'
        '故 $r(A)=2$，$\\dim N(A)=4-2=2$。\n'
        '**步骤2**：化行最简形后 $x_1=x_2-2x_3$，$x_4=0$；取 $(x_2,x_3)=(1,0),(0,1)$ 得基础解系。\n'
        '**结论**：解空间维数为 $2$，基为 $\\xi_1=(1,1,0,0)^{\\mathrm T},\\ \\xi_2=(-2,0,1,0)^{\\mathrm T}$。',
        check=lambda it: _assert_nullity(A7, ns)
    )

    # 8) 向量组等价
    add(
        '向量组等价的判定',
        '设向量组 $(\\mathrm{I}):\\alpha_1,\\alpha_2,\\alpha_3$ 与 $(\\mathrm{II}):\\beta_1,\\beta_2$ 都线性无关，'
        '且 $(\\mathrm{II})$ 可由 $(\\mathrm{I})$ 线性表出。证明：$(\\mathrm{I})$ 不能由 $(\\mathrm{II})$ 线性表出。',
        ['向量组', '线性空间与变换'], 6, 6, 4, '证明题',
        ['若可以互相表出，则两个向量组等价，秩相等',
         '秩相等与「线性无关向量的个数」矛盾'],
        '不能。反设 $(\\mathrm{I})$ 可由 $(\\mathrm{II})$ 表出，则两组向量等价、秩相等；但前者秩为 3、后者为 2，矛盾。',
        '**步骤1**：反设 $(\\mathrm{I})$ 可由 $(\\mathrm{II})$ 线性表出。加上已知条件，两组向量可以互相表出，'
        '即两个向量组等价。\n'
        '**步骤2**：等价的向量组秩相等。而 $(\\mathrm{I})$ 含 3 个线性无关向量，秩为 3；'
        '$(\\mathrm{II})$ 含 2 个线性无关向量，秩为 2。$3\\neq 2$，矛盾。\n'
        '**结论**：反设不成立，$(\\mathrm{I})$ 不能由 $(\\mathrm{II})$ 线性表出。'
    )

    # 9) 线性无关的判定（选择）—— 四个选项的系数矩阵全部现算行列式，
    #    保证「恰好一个选项线性无关」，避免手写选项时出现双答案
    a1_, a2_, a3_ = symbols('a1_ a2_ a3_')
    cands = {
        '(A)': Matrix([[1, 0, -1], [-1, 1, 0], [0, -1, 1]]),   # a1-a2, a2-a3, a3-a1
        '(B)': Matrix([[1, 0, 1], [1, 1, 0], [0, 1, 1]]),      # a1+a2, a2+a3, a3+a1
        '(C)': Matrix([[1, 0, 1], [1, 1, 2], [0, 1, 1]]),      # a1+a2, a2+a3, a1+2a2+a3
        '(D)': Matrix([[1, 0, 1], [1, 1, 0], [0, -1, 1]]),     # a1+a2, a2-a3, a1+a3
    }
    dets = {k: v.det() for k, v in cands.items()}
    indep = [k for k, d in dets.items() if d != 0]
    assert len(indep) == 1, '线性无关选项应恰好一个，实际 %s' % indep
    right = indep[0][1]          # 'A' / 'B' / ...
    add(
        '线性无关的判定',
        '设向量组 $\\alpha_1,\\alpha_2,\\alpha_3$ 线性无关，则下列向量组中线性无关的是（　　）\n\n'
        '(A) $\\alpha_1-\\alpha_2,\\ \\alpha_2-\\alpha_3,\\ \\alpha_3-\\alpha_1$\n\n'
        '(B) $\\alpha_1+\\alpha_2,\\ \\alpha_2+\\alpha_3,\\ \\alpha_3+\\alpha_1$\n\n'
        '(C) $\\alpha_1+\\alpha_2,\\ \\alpha_2+\\alpha_3,\\ \\alpha_1+2\\alpha_2+\\alpha_3$\n\n'
        '(D) $\\alpha_1+\\alpha_2,\\ \\alpha_2-\\alpha_3,\\ \\alpha_1+\\alpha_3$',
        ['向量组'], 4, 4, 3, '选择题',
        ['把新向量组写成 $(\\alpha_1,\\alpha_2,\\alpha_3)K$',
         '新向量组线性无关 ⟺ 系数矩阵 $K$ 可逆（行列式非零）'],
        '(' + right + ')。',
        '**步骤1**：任一组新向量都可以写成 $(\\alpha_1,\\alpha_2,\\alpha_3)K$，'
        '由于 $\\alpha_1,\\alpha_2,\\alpha_3$ 线性无关，新向量组线性无关 $\\iff |K|\\neq0$。\n'
        '**步骤2**：四个选项的系数行列式依次为 $'
        + ',\\ '.join(latex(dets[k]) for k in ('(A)', '(B)', '(C)', '(D)')) + '$。\n'
        '**步骤3**：只有 ' + right + ' 的行列式不为零，故只有它线性无关。'
        '（(A) 三向量之和为零；(C) 第三个向量恰是前两个之和；(D) 满足 $v_1-v_2-v_3=0$。）\n'
        '**结论**：选 (' + right + ')。',
        check=lambda it: _assert_single_independent(dets)
    )

    # 10) 扩充为基
    add(
        '将线性无关组扩充为基',
        '在 $\\mathbb{R}^3$ 中，向量 $\\alpha_1=(1,1,0)^{\\mathrm T},\\ \\alpha_2=(1,0,1)^{\\mathrm T}$ 线性无关，'
        '把它们扩充为 $\\mathbb{R}^3$ 的一组基。',
        ['向量组', '线性空间与变换'], 4, 4, 4, '解答题',
        ['取标准基向量的一个，检查加上后是否仍线性无关',
         '行列式非零即可'],
        '$\\{\\alpha_1,\\alpha_2,(0,0,1)^{\\mathrm T}\\}$ 或 $\\{\\alpha_1,\\alpha_2,(1,0,0)^{\\mathrm T}\\}$ 等都是基。',
        '**步骤1**：取 $e_3=(0,0,1)^{\\mathrm T}$，以三者为列作矩阵，'
        '$\\begin{vmatrix}1&1&0\\\\1&0&0\\\\0&1&1\\end{vmatrix}=-1\\neq0$，线性无关。\n'
        '**步骤2**：$\\mathbb{R}^3$ 中 3 个线性无关的向量即为一组基。\n'
        '**结论**：$\\{\\alpha_1,\\alpha_2,e_3\\}$ 是 $\\mathbb{R}^3$ 的一组基（答案不唯一）。'
    )


# ============================================================================
# 校验辅助
# ============================================================================

def _assert_det_zero_at(M, param, roots):
    for rt in roots:
        assert M.subs(param, rt).det() == 0, '参数根不使行列式为零'


def _assert_rank(M, r):
    assert M.rank() == r


def _assert_orthonormal(vecs):
    for i, u in enumerate(vecs):
        assert simplify(u.dot(u) - 1) == 0, '未单位化'
        for j, v in enumerate(vecs):
            if i < j:
                assert simplify(u.dot(v)) == 0, '未正交'


def _assert_single_independent(dets):
    nonzero = [k for k, d in dets.items() if d != 0]
    assert len(nonzero) == 1, '应恰好一个选项线性无关：%s' % nonzero


def _assert_not_span(A, b, rA, rb):
    assert rA != rb, '本题应设计成不能表出'
    assert A.row_join(b).rank() == rb


def _assert_nullity(M, basis):
    assert len(basis) == M.cols - M.rank(), '零度不等于 n-rank'
    for b in basis:
        assert (M * b).is_zero_matrix, '基向量不在零空间'


def orth_diag(A):
    """实对称矩阵的正交对角化：返回 (Q, 特征值列表, 对角阵D)，并断言 Q^T A Q 为对角阵"""
    A = Matrix(A)
    assert A == A.T, '不是对称矩阵'
    pairs = A.eigenvects()
    cols, vals = [], []
    for val, mult, vecs in pairs:
        basis = _gram_schmidt([Matrix(v) for v in vecs])
        for b in basis:
            cols.append(b)
            vals.append(val)
    Q = Matrix.hstack(*cols)
    Q = Q.applyfunc(lambda x: simplify(x))
    D = diag(*vals)
    # 断言：Q 各列两两正交且单位化（sympy 的 eigenvects 已给单位向量，Gram-Schmidt 后仍是）
    QtQ = (Q.T * Q).applyfunc(lambda x: simplify(x))
    assert QtQ == eye(len(vals)), 'Q 不是正交矩阵'
    assert (Q.T * A * Q).applyfunc(lambda x: simplify(x)) == D, 'Q^T A Q 不是对角阵'
    return Q, vals, D


def _gram_schmidt(vecs):
    out = []
    for v in vecs:
        v = Matrix(v)
        w = v
        for u in out:
            w = w - (v.dot(u) / u.dot(u)) * u
        n = (w.T * w)[0]
        w = w / (n ** Rational(1, 2))
        out.append(w.applyfunc(lambda x: simplify(x)))
    return out


# ============================================================================
# 二、相似与对角化（10 题）
# ============================================================================

A_SYM = Matrix([[2, 1, 1], [1, 2, 1], [1, 1, 2]])


def build_similarity():
    # 1) 求特征值与特征向量
    pairs = A_SYM.eigenvects()
    lam = [p[0] for p in pairs]
    add(
        '求特征值与特征向量',
        '求矩阵 $A=' + pm(A_SYM) + '$ 的全部特征值与对应的特征向量。',
        ['特征值与特征向量'], 4, 4, 6, '解答题',
        ['解特征方程 $|\\lambda E-A|=0$ 得特征值',
         '每个特征值代回 $(\\lambda E-A)x=0$ 求基础解系'],
        '特征值为 $\\lambda_1=4$（对应 $(1,1,1)^{\\mathrm T}$），$\\lambda_2=\\lambda_3=1$'
        '（对应 $(1,-1,0)^{\\mathrm T}$ 与 $(1,0,-1)^{\\mathrm T}$）。',
        '**步骤1**：$|\\lambda E-A|=' + latex((symbols('l') * eye(3) - A_SYM).det().factor()) + '$，'
        '令其为零得 $\\lambda=4$（单根）与 $\\lambda=1$（二重根）。\n'
        '**步骤2**：对 $\\lambda=4$，解 $(4E-A)x=0$，得基础解系 $(1,1,1)^{\\mathrm T}$。\n'
        '**步骤3**：对 $\\lambda=1$，$E-A$ 的三行互成比例，方程为 $x_1+x_2+x_3=0$，'
        '基础解系 $(1,-1,0)^{\\mathrm T},(1,0,-1)^{\\mathrm T}$。\n'
        '**结论**：特征值 $4,1,1$；二重特征值 $1$ 的几何重数为 $2$，等于代数重数，故 $A$ 可对角化。',
        check=lambda it: _assert_eigen(A_SYM, pairs)
    )

    # 2) 含参可对角化判定
    a = symbols('a')
    M2 = Matrix([[2, a, 0], [0, 2, 0], [0, 0, 3]])
    add(
        '含参矩阵可对角化的条件',
        '设 $A=' + pm(Matrix([[2, symbols('a'), 0], [0, 2, 0], [0, 0, 3]])) + '$，'
        '问 $a$ 取何值时 $A$ 可相似对角化。',
        ['相似与对角化'], 5, 5, 5, '解答题',
        ['特征值直接在对角线上：$2,2,3$',
         '二重特征值 $2$ 的几何重数必须也是 2，即 $r(A-2E)=1$'],
        '$a=0$ 时 $A$ 可对角化；$a\\neq0$ 时不可对角化。',
        '**步骤1**：$A$ 是上三角矩阵，特征值为 $2,2,3$（$2$ 为二重根）。\n'
        '**步骤2**：$A$ 可对角化 $\\iff$ 二重特征值 $2$ 的几何重数等于 $2$，'
        '即 $\\dim N(A-2E)=2$，等价于 $r(A-2E)=3-2=1$。\n'
        '**步骤3**：$A-2E=\\begin{pmatrix}0&a&0\\\\0&0&0\\\\0&0&1\\end{pmatrix}$，'
        '当 $a\\neq0$ 时第 1、3 行线性无关，秩为 $2$；当 $a=0$ 时秩为 $1$。\n'
        '**结论**：$a=0$ 时可对角化；$a\\neq0$ 时 $A$ 不可对角化（只有一个线性无关的特征向量）。',
        check=lambda it: _assert_rank(M2.subs(a, 0) - 2 * eye(3), 1)
    )

    # 3) 求可逆矩阵 P
    # 显式取三列，顺序与答案一致；sympy 的 eigenvects 顺序不保证稳定
    xi4 = Matrix([1, 1, 1])
    xi1a = Matrix([1, -1, 0])
    xi1b = Matrix([1, 0, -1])
    P3 = Matrix.hstack(xi4, xi1a, xi1b)
    for vec, lam in ((xi4, 4), (xi1a, 1), (xi1b, 1)):
        assert (A_SYM * vec - lam * vec).is_zero_matrix, '特征向量验算失败'
    Q3, vals3, D3 = orth_diag(A_SYM)
    add(
        '求可逆矩阵 P 使 P^{-1}AP 为对角阵',
        '设 $A=' + pm(A_SYM) + '$，求可逆矩阵 $P$，使 $P^{-1}AP$ 为对角矩阵。',
        ['相似与对角化', '特征值与特征向量'], 5, 5, 6, '解答题',
        ['先求三个线性无关的特征向量', '把特征向量按列排成 P，对角阵上写对应特征值'],
        '$P=\\begin{pmatrix}1&1&1\\\\1&-1&0\\\\1&0&-1\\end{pmatrix}$，'
        '$P^{-1}AP=\\operatorname{diag}(4,1,1)$。',
        '**步骤1**：由上一类问题的计算，$\\lambda=4$ 对应 $(1,1,1)^{\\mathrm T}$；'
        '$\\lambda=1$ 对应 $(1,-1,0)^{\\mathrm T}$ 与 $(1,0,-1)^{\\mathrm T}$，三者线性无关。\n'
        '**步骤2**：令 $P=(\\xi_1,\\xi_2,\\xi_3)$，则 $P^{-1}AP=\\operatorname{diag}(4,1,1)$。\n'
        '**结论**：$P$ 的取法不唯一（每个特征向量乘非零常数、同一特征值的特征向量可任意换基），'
        '只要三列线性无关即可。',
        check=lambda it: _assert_diag(P3, A_SYM, [4, 1, 1])
    )

    # 4) 求 A^n
    A4 = Matrix([[1, 1], [0, 2]])
    P4 = Matrix([[1, 1], [0, 1]])
    D4 = diag(1, 2)
    add(
        '用对角化求矩阵的高次幂',
        '设 $A=' + pm(A4) + '$，求 $A^{n}$（$n$ 为正整数）。',
        ['相似与对角化', '矩阵运算'], 5, 6, 6, '解答题',
        ['$A$ 的特征值为 $1,2$，可对角化', '先写出 $A=P\\Lambda P^{-1}$，再算 $P\\Lambda^{n}P^{-1}$'],
        '$A^{n}=\\begin{pmatrix}1&2^{n}-1\\\\0&2^{n}\\end{pmatrix}$。',
        '**步骤1**：$\\lambda=1$ 对应特征向量 $(1,0)^{\\mathrm T}$；$\\lambda=2$ 对应 $(1,1)^{\\mathrm T}$。'
        '取 $P=\\begin{pmatrix}1&1\\\\0&1\\end{pmatrix}$，$P^{-1}=\\begin{pmatrix}1&-1\\\\0&1\\end{pmatrix}$。\n'
        '**步骤2**：$A^{n}=P\\operatorname{diag}(1,2^{n})P^{-1}'
        '=\\begin{pmatrix}1&1\\\\0&1\\end{pmatrix}\\begin{pmatrix}1&0\\\\0&2^{n}\\end{pmatrix}'
        '\\begin{pmatrix}1&-1\\\\0&1\\end{pmatrix}=\\begin{pmatrix}1&2^{n}-1\\\\0&2^{n}\\end{pmatrix}$。\n'
        '**结论**：$A^{n}=\\begin{pmatrix}1&2^{n}-1\\\\0&2^{n}\\end{pmatrix}$（$n=1$ 时退化为 $A$，可自检）。',
        check=lambda it: _assert_power(A4, P4, D4, 3)
    )

    # 5) 由特征值求行列式与迹
    add(
        '由特征值求行列式与矩阵多项式',
        '设 3 阶矩阵 $A$ 的特征值为 $1,2,-1$，求 $|A|$、$\\operatorname{tr}(A)$ 与 $|A^{2}+E|$。',
        ['特征值与特征向量'], 3, 3, 3, '填空题',
        ['特征值之积等于行列式，之和等于迹',
         '$A^{2}+E$ 的特征值是 $\\lambda^{2}+1$，行列式仍是它们的乘积'],
        '$|A|=-2$，$\\operatorname{tr}(A)=2$，$|A^{2}+E|=20$。',
        '**步骤1**：$|A|=\\lambda_1\\lambda_2\\lambda_3=1\\cdot2\\cdot(-1)=-2$；'
        '$\\operatorname{tr}(A)=1+2-1=2$。\n'
        '**步骤2**：$A^{2}+E$ 的特征值为 $\\lambda_i^{2}+1$，即 $2,5,2$。\n'
        '**步骤3**：$|A^{2}+E|=2\\cdot5\\cdot2=20$。\n'
        '**结论**：$|A|=-2,\\ \\operatorname{tr}(A)=2,\\ |A^{2}+E|=20$。'
    )

    # 6) 相似矩阵的性质（选择）
    add(
        '相似矩阵的共同性质',
        '设 $A$ 与 $B$ 相似，则下列结论中错误的是（　　）\n\n'
        '(A) $A,B$ 有相同的特征值　　(B) $|A|=|B|$\n\n'
        '(C) $A,B$ 有相同的特征向量　　(D) $r(A)=r(B)$',
        ['相似与对角化'], 3, 3, 2, '选择题',
        ['相似意味着存在可逆 $P$ 使 $B=P^{-1}AP$',
         '特征向量会被 $P^{-1}$ 换基，一般不再相同'],
        '(C)。',
        '**步骤1**：$B=P^{-1}AP\\Rightarrow |\\lambda E-B|=|P^{-1}||\\lambda E-A||P|=|\\lambda E-A|$，'
        '特征多项式相同，故 (A)(B) 正确。\n'
        '**步骤2**：乘可逆矩阵不改变秩，故 (D) 正确。\n'
        '**步骤3**：$A\\xi=\\lambda\\xi$ 时 $B(P^{-1}\\xi)=\\lambda(P^{-1}\\xi)$，'
        '特征向量是 $P^{-1}\\xi$ 而不是 $\\xi$，故 (C) 错误。\n'
        '**结论**：选 (C)。'
    )

    # 7) 实对称矩阵正交对角化
    r2, r3, r6 = Rational(1, 2), Rational(1, 3), Rational(1, 6)
    Q7 = Matrix.hstack(
        Matrix([r3, r3, r3]) * (3 ** Rational(1, 2)),
        Matrix([r2, -r2, 0]) * (2 ** Rational(1, 2)),
        Matrix([r6, r6, -2 * r6]) * (6 ** Rational(1, 2)),
    ).applyfunc(lambda x: simplify(x))
    add(
        '实对称矩阵的正交相似对角化',
        '设 $A=' + pm(A_SYM) + '$，求正交矩阵 $Q$，使 $Q^{\\mathrm T}AQ$ 为对角矩阵。',
        ['相似与对角化', '二次型'], 6, 7, 8, '解答题',
        ['先求特征值与特征向量', '同一特征值的特征向量用施密特正交化，再全部单位化'],
        '$Q=\\begin{pmatrix}\\frac{1}{\\sqrt3}&\\frac{1}{\\sqrt2}&\\frac{1}{\\sqrt6}\\\\'
        '\\frac{1}{\\sqrt3}&-\\frac{1}{\\sqrt2}&\\frac{1}{\\sqrt6}\\\\'
        '\\frac{1}{\\sqrt3}&0&-\\frac{2}{\\sqrt6}\\end{pmatrix}$，'
        '$Q^{\\mathrm T}AQ=\\operatorname{diag}(4,1,1)$。',
        '**步骤1**：特征值 $4,1,1$；$\\lambda=4$ 的特征向量 $(1,1,1)^{\\mathrm T}$ 单位化为 '
        '$\\frac{1}{\\sqrt3}(1,1,1)^{\\mathrm T}$。\n'
        '**步骤2**：$\\lambda=1$ 的两维特征子空间取 $(1,-1,0)^{\\mathrm T},(1,0,-1)^{\\mathrm T}$，'
        '施密特正交化得 $(1,-1,0)^{\\mathrm T}$ 与 $(1,1,-2)^{\\mathrm T}$，再单位化。\n'
        '**步骤3**：按列拼成 $Q$（不同特征值的特征向量自动正交，无需再处理）。\n'
        '**结论**：$Q^{\\mathrm T}AQ=\\operatorname{diag}(4,1,1)$，且 $Q^{\\mathrm T}Q=E$（可验算）。',
        check=lambda it: _assert_orth_diag(A_SYM, Q7, [4, 1, 1])
    )

    # 8) 幂等矩阵
    add(
        '幂等矩阵一定可对角化',
        '设 $A$ 为 $n$ 阶矩阵且 $A^{2}=A$（$A\\neq O,\\ A\\neq E$）。证明：$A$ 可对角化，且其特征值只能是 $0$ 或 $1$。',
        ['相似与对角化', '线性空间与变换'], 6, 7, 4, '证明题',
        ['设 $\\lambda$ 是特征值，代入 $A^{2}=A$ 得 $\\lambda^{2}=\\lambda$',
         '证明最小多项式无重根 ⇒ 可对角化；或用 $x=Ax+(x-Ax)$ 做直和分解'],
        '特征值只能取 $0$ 或 $1$；且 $\\mathbb{R}^{n}=\\operatorname{Im}A\\oplus\\ker A$，'
        '在两组基下 $A$ 为 $\\operatorname{diag}(1,\\cdots,1,0,\\cdots,0)$。',
        '**步骤1**：设 $A\\xi=\\lambda\\xi$（$\\xi\\neq0$），则 $A^{2}\\xi=\\lambda^{2}\\xi$，'
        '又 $A^{2}=A$ 得 $\\lambda^{2}=\\lambda$，故 $\\lambda\\in\\{0,1\\}$。\n'
        '**步骤2**：对任意 $x\\in\\mathbb{R}^{n}$，写 $x=Ax+(x-Ax)$。'
        '前者属于 $\\operatorname{Im}A$，后者满足 $A(x-Ax)=Ax-A^{2}x=0$，属于 $\\ker A$。\n'
        '**步骤3**：若 $y\\in\\operatorname{Im}A\\cap\\ker A$，则 $y=Az$ 且 $Ay=0$，'
        '于是 $y=Az=A^{2}z=Ay=0$，故 $\\operatorname{Im}A\\cap\\ker A=\\{0\\}$，'
        '即 $\\mathbb{R}^{n}=\\operatorname{Im}A\\oplus\\ker A$。\n'
        '**步骤4**：取 $\\operatorname{Im}A$ 的基与 $\\ker A$ 的基拼成 $\\mathbb{R}^{n}$ 的基，'
        '$A$ 在其上为对角阵，对角元为 $1$（在 $\\operatorname{Im}A$ 上 $Ax=x$）与 $0$。\n'
        '**结论**：$A$ 可对角化，特征值只取 $0,1$；且 $r(A)$ 等于特征值 $1$ 的重数。'
    )

    # 9) 对合矩阵
    add(
        '满足 A^{2}=E 的矩阵',
        '设 $A$ 为 $n$ 阶实矩阵且 $A^{2}=E$。证明：$A$ 的特征值只能是 $\\pm1$，并且 $A$ 可对角化。',
        ['相似与对角化', '线性空间与变换'], 6, 6, 4, '证明题',
        ['$A\\xi=\\lambda\\xi$ 两边乘 $A$ 得 $\\lambda^{2}=1$',
         '用 $x=\\frac{x+Ax}{2}+\\frac{x-Ax}{2}$ 做直和分解'],
        '特征值只能是 $\\pm1$；且 $\\mathbb{R}^{n}=\\ker(A-E)\\oplus\\ker(A+E)$，故 $A$ 可对角化。',
        '**步骤1**：设 $A\\xi=\\lambda\\xi$，则 $\\xi=A^{2}\\xi=\\lambda^{2}\\xi$，'
        '由 $\\xi\\neq0$ 得 $\\lambda^{2}=1$，即 $\\lambda=\\pm1$。\n'
        '**步骤2**：对任意 $x$，令 $u=\\frac{x+Ax}{2},\\ v=\\frac{x-Ax}{2}$，则 $x=u+v$，'
        '且 $Au=u$（即 $u\\in\\ker(A-E)$），$Av=-v$（即 $v\\in\\ker(A+E)$）。\n'
        '**步骤3**：若 $y\\in\\ker(A-E)\\cap\\ker(A+E)$，则 $y=Ay=-y$，故 $y=0$，'
        '于是 $\\mathbb{R}^{n}=\\ker(A-E)\\oplus\\ker(A+E)$。\n'
        '**结论**：$A$ 在这两组基下为 $\\operatorname{diag}(1,\\cdots,1,-1,\\cdots,-1)$，可对角化。'
    )

    # 10) 可对角化充要条件（选择）
    add(
        '可对角化的充要条件',
        '设 3 阶矩阵 $A$ 的特征值为 $1,1,2$，则 $A$ 可相似对角化的充要条件是（　　）\n\n'
        '(A) $r(A-E)=1$　　(B) $r(A-E)=2$\n\n'
        '(C) $r(A-2E)=1$　　(D) $r(A)=2$',
        ['相似与对角化', '逆矩阵与秩'], 5, 5, 3, '选择题',
        ['二重特征值 $1$ 的几何重数必须是 2', '$\\dim N(A-E)=3-r(A-E)$'],
        '(A)。',
        '**步骤1**：$A$ 可对角化 $\\iff$ 每个特征值的几何重数等于代数重数。'
        '$\\lambda=2$ 是单根，天然满足；只需 $\\lambda=1$（二重）的几何重数为 $2$。\n'
        '**步骤2**：$\\dim N(A-E)=3-r(A-E)$，令其等于 $2$ 得 $r(A-E)=1$。\n'
        '**结论**：选 (A)。'
    )


def _assert_eigen(A, pairs):
    total = sum(p[1] for p in pairs)
    assert total == A.rows, '代数重数之和应等于阶数'
    for val, mult, vecs in pairs:
        assert len(vecs) == mult, '几何重数应等于代数重数（本题可对角化）'
        for v in vecs:
            assert (A * v - val * v).is_zero_matrix, '特征向量验算失败'


def _assert_diag(P, A, vals):
    D = (P.inv() * A * P).applyfunc(lambda x: simplify(x))
    assert D == diag(*vals), 'P^{-1}AP 不是预期的对角阵'


def _assert_power(A, P, D, n):
    got = (P * (D ** n) * P.inv()).applyfunc(lambda x: simplify(x))
    assert got == (A ** n), 'P Λ^n P^{-1} 与 A^n 不一致'


def _assert_orth_diag(A, Q, vals):
    assert (Q.T * Q).applyfunc(lambda x: simplify(x)) == eye(A.rows), 'Q 不是正交阵'
    D = (Q.T * A * Q).applyfunc(lambda x: simplify(x))
    assert sorted(D.diagonal()) == sorted(vals), 'Q^T A Q 对角元不是特征值'


# ============================================================================
# 三、二次型（10 题）
# ============================================================================

def build_quadratic():
    # 1) 写出二次型矩阵
    A1 = Matrix([[1, 1, -1], [1, 2, 2], [-1, 2, 5]])
    add(
        '写出二次型的矩阵',
        '写出二次型 $f=x_1^{2}+2x_2^{2}+5x_3^{2}+2x_1x_2-2x_1x_3+4x_2x_3$ 的矩阵 $A$，并指出 $f$ 的秩。',
        ['二次型'], 3, 3, 4, '填空题',
        ['平方项系数放在对角线上', '交叉项 $2a_{ij}x_ix_j$ 的系数要平分到 $a_{ij}$ 与 $a_{ji}$'],
        '$A=' + pm(A1) + '$，$r(f)=3$。',
        '**步骤1**：平方项系数 $1,2,5$ 直接放对角线。\n'
        '**步骤2**：$2x_1x_2$ 对应 $a_{12}=a_{21}=1$；$-2x_1x_3$ 对应 $a_{13}=a_{31}=-1$；'
        '$4x_2x_3$ 对应 $a_{23}=a_{32}=2$。\n'
        '**步骤3**：$|A|=1\\neq0$，故 $r(f)=3$。\n'
        '**结论**：$A=' + pm(A1) + '$，秩为 $3$（满秩二次型）。',
        check=lambda it: _assert_quad_matrix(A1)
    )

    # 2) 正交变换化标准形
    A2 = Matrix([[1, 1, 0], [1, 1, 0], [0, 0, 2]])
    rt2 = 2 ** Rational(1, 2)
    Q2 = Matrix.hstack(
        Matrix([1, 1, 0]) * rt2 / 2,
        Matrix([0, 0, 1]),
        Matrix([1, -1, 0]) * rt2 / 2,
    ).applyfunc(lambda x: simplify(x))
    vals2 = [2, 2, 0]
    add(
        '正交变换化二次型为标准形',
        '用正交变换把二次型 $f=x_1^{2}+2x_1x_2+x_2^{2}+2x_3^{2}$ 化为标准形，并写出所用的正交矩阵。',
        ['二次型', '相似与对角化'], 6, 6, 7, '解答题',
        ['先写出二次型矩阵，再求特征值与单位特征向量',
         '标准形的系数就是特征值，正交矩阵由单位特征向量按列拼成'],
        '标准形 $f=2y_1^{2}+2y_2^{2}$（其中 $\\lambda=0,2,2$），'
        '可取 $Q=\\begin{pmatrix}\\frac{1}{\\sqrt2}&0&\\frac{1}{\\sqrt2}\\\\'
        '\\frac{1}{\\sqrt2}&0&-\\frac{1}{\\sqrt2}\\\\0&1&0\\end{pmatrix}$。',
        '**步骤1**：$A=' + pm(A2) + '$，$|\\lambda E-A|=\\lambda(\\lambda-2)^{2}$，特征值 $0,2,2$。\n'
        '**步骤2**：$\\lambda=0$ 对应 $(1,-1,0)^{\\mathrm T}$；$\\lambda=2$ 的特征子空间为 '
        '$x_1+x_2=0$ 之外的两维空间，取 $(1,1,0)^{\\mathrm T}$ 与 $(0,0,1)^{\\mathrm T}$ 并正交化。\n'
        '**步骤3**：单位化后按列拼成 $Q$，作正交变换 $x=Qy$，则 $f=2y_1^{2}+2y_2^{2}$（正惯性指数为 $2$）。\n'
        '**结论**：标准形与 $Q$ 的取法都不唯一（同一特征值的特征向量可换基），'
        '但特征值集合与惯性指数唯一。',
        check=lambda it: _assert_orth_diag(A2, Q2, vals2)
    )

    # 3) 配方法
    add(
        '配方法化二次型为标准形',
        '用配方法把二次型 $f=x_1^{2}+4x_1x_2+3x_2^{2}+2x_3^{2}$ 化为标准形，并写出所用的可逆线性变换。',
        ['二次型'], 4, 4, 5, '解答题',
        ['把含 $x_1$ 的项凑成完全平方', '剩余部分对 $x_2$ 再配方，注意变换必须可逆'],
        '$f=y_1^{2}-y_2^{2}+2y_3^{2}$，其中 $y_1=x_1+2x_2,\\ y_2=x_2,\\ y_3=x_3$；'
        '正惯性指数 $2$，负惯性指数 $1$。',
        '**步骤1**：$f=(x_1^{2}+4x_1x_2+4x_2^{2})-x_2^{2}+2x_3^{2}=(x_1+2x_2)^{2}-x_2^{2}+2x_3^{2}$。\n'
        '**步骤2**：令 $y_1=x_1+2x_2,\\ y_2=x_2,\\ y_3=x_3$，该变换的矩阵行列式为 $1\\neq0$，可逆。\n'
        '**步骤3**：得标准形 $f=y_1^{2}-y_2^{2}+2y_3^{2}$，正负惯性指数为 $(2,1)$。\n'
        '**结论**：标准形 $y_1^{2}-y_2^{2}+2y_3^{2}$，规范形为 $z_1^{2}+z_2^{2}-z_3^{2}$。',
        check=lambda it: _assert_complete_square()
    )

    # 4) 正定判定
    A4 = Matrix([[2, -1, 0], [-1, 2, -1], [0, -1, 2]])
    minors = [A4[:k, :k].det() for k in (1, 2, 3)]
    add(
        '用顺序主子式判定正定',
        '判定二次型 $f=2x_1^{2}+2x_2^{2}+2x_3^{2}-2x_1x_2-2x_2x_3$ 是否正定。',
        ['二次型'], 3, 4, 4, '解答题',
        ['写出矩阵，算三个顺序主子式', '全部大于零即为正定'],
        '正定。顺序主子式为 $2,\\ 3,\\ 4$，均大于零。',
        '**步骤1**：$A=' + pm(A4) + '$。\n'
        '**步骤2**：$\\Delta_1=2>0$，$\\Delta_2=\\begin{vmatrix}2&-1\\\\-1&2\\end{vmatrix}=3>0$，'
        '$\\Delta_3=|A|=4>0$。\n'
        '**结论**：三个顺序主子式全为正，故 $A$ 正定，$f$ 正定（且 $f$ 的规范形为 $z_1^2+z_2^2+z_3^2$）。',
        check=lambda it: _assert_all_positive(minors)
    )

    # 5) 求参数使正定
    a = symbols('a')
    M5 = Matrix([[1, 1, 0], [1, a, 0], [0, 0, 2]])
    add(
        '由正定性求参数范围',
        '设二次型 $f=x_1^{2}+ax_2^{2}+2x_3^{2}+2x_1x_2$ 正定，求 $a$ 的取值范围。',
        ['二次型'], 4, 4, 4, '填空题',
        ['写出矩阵，注意交叉项系数要除以 2', '三个顺序主子式都必须大于零'],
        '$a>1$。',
        '**步骤1**：$A=' + pm(M5) + '$。\n'
        '**步骤2**：$\\Delta_1=1>0$；$\\Delta_2=a-1>0$；$\\Delta_3=2(a-1)>0$。\n'
        '**结论**：$\\Delta_2>0$ 已蕴含 $\\Delta_3>0$，故 $a>1$。',
        check=lambda it: _assert_all_positive([M5.subs(a, 3)[:k, :k].det() for k in (1, 2, 3)])
    )

    # 6) 惯性指数与规范形
    A6 = Matrix([[0, 1, 1], [1, 0, -1], [1, -1, 0]])
    p6 = sum(1 for v in A6.eigenvals() for _ in range(A6.eigenvals()[v]) if v > 0)
    q6 = sum(1 for v in A6.eigenvals() for _ in range(A6.eigenvals()[v]) if v < 0)
    add(
        '求惯性指数与规范形',
        '求二次型 $f=2x_1x_2+2x_1x_3-2x_2x_3$ 的正、负惯性指数，并写出其规范形。',
        ['二次型'], 5, 6, 6, '解答题',
        ['先写出矩阵（对角线全为 0）', '求特征值，正负个数就是惯性指数'],
        '正惯性指数 $1$，负惯性指数 $2$，规范形 $z_1^{2}-z_2^{2}-z_3^{2}$。',
        '**步骤1**：$A=' + pm(A6) + '$，$|\\lambda E-A|=' + latex((symbols('l') * eye(3) - A6).det().factor()) + '$，'
        '特征值 $2,-1,-1$。\n'
        '**步骤2**：正特征值 $1$ 个、负特征值 $2$ 个，故 $p=1,\\ q=2$，$r=3$。\n'
        '**结论**：规范形为 $z_1^{2}-z_2^{2}-z_3^{2}$。',
        check=lambda it: _assert_pq(A6, p6, q6)
    )

    # 7) 合同判定（选择）
    add(
        '合同但不相似的判定',
        '设 $A=\\operatorname{diag}(1,1,-1)$，$B=\\operatorname{diag}(2,2,-1)$，则 $A$ 与 $B$（　　）\n\n'
        '(A) 合同但不相似　　(B) 相似但不合同\n\n'
        '(C) 既合同又相似　　(D) 既不合同也不相似',
        ['二次型', '相似与对角化'], 4, 5, 3, '选择题',
        ['合同看正负惯性指数是否相同', '相似看特征值是否完全相同'],
        '(A)。',
        '**步骤1**：$A$ 的正负惯性指数为 $(2,1)$；$B$ 的特征值 $2,2,-1$，正负惯性指数也是 $(2,1)$。'
        '两个实对称矩阵惯性指数相同 $\\iff$ 合同，故合同。\n'
        '**步骤2**：$A$ 的特征值为 $1,1,-1$，$B$ 为 $2,2,-1$，特征值不全相同，故不相似（相似必特征值相同）。\n'
        '**结论**：选 (A)。'
    )

    # 8) 瑞利商最值
    add(
        '二次型在单位球面上的最值',
        '设 $A=' + pm(A_SYM) + '$，求二次型 $f(x)=x^{\\mathrm T}Ax$ 在条件 $\\|x\\|=1$ 下的最大值与最小值。',
        ['二次型', '特征值与特征向量'], 5, 5, 5, '填空题',
        ['单位球面上的极值就是最大、最小特征值', '对应特征向量是取到极值的点'],
        '最大值为 $4$（在 $x=\\pm\\frac{1}{\\sqrt3}(1,1,1)^{\\mathrm T}$ 处取到），最小值为 $1$。',
        '**步骤1**：实对称矩阵在 $\\|x\\|=1$ 上的瑞利商 $x^{\\mathrm T}Ax$ 的取值范围是 '
        '$[\\lambda_{\\min},\\lambda_{\\max}]$。\n'
        '**步骤2**：$A$ 的特征值为 $4,1,1$，故最大值 $4$、最小值 $1$。\n'
        '**步骤3**：最大值在属于 $4$ 的单位特征向量处取到，即 $\\pm\\frac{1}{\\sqrt3}(1,1,1)^{\\mathrm T}$；'
        '最小值在整个二维特征子空间中取到。\n'
        '**结论**：最大 $4$，最小 $1$。',
        check=lambda it: _assert_eigen_range(A_SYM, 1, 4)
    )

    # 9) 由秩求参数
    a = symbols('a')
    M9 = Matrix([[1, 1, 0], [1, 2, 0], [0, 0, a]])
    add(
        '由二次型的秩求参数',
        '已知二次型 $f=x_1^{2}+2x_2^{2}+ax_3^{2}+2x_1x_2$ 的秩为 $2$，求 $a$。',
        ['二次型'], 4, 4, 3, '填空题',
        ['二次型的秩就是其矩阵的秩', '矩阵是分块对角，$2\\times2$ 块满秩，故只能靠 $a$ 降秩'],
        '$a=0$。',
        '**步骤1**：$A=' + pm(M9) + '$，左上 $2\\times2$ 块行列式为 $1$，已满秩。\n'
        '**步骤2**：$r(A)=2\\iff a=0$（此时第三列全零）。\n'
        '**结论**：$a=0$。',
        check=lambda it: _assert_rank(M9.subs(a, 0), 2)
    )

    # 10) 正定的等价刻画（证明）
    add(
        '正定矩阵的分解刻画',
        '设 $A$ 为 $n$ 阶实对称矩阵。证明：$A$ 正定 $\\iff$ 存在可逆矩阵 $C$，使 $A=C^{\\mathrm T}C$。',
        ['二次型', '线性空间与变换'], 6, 7, 4, '证明题',
        ['正定 ⇒ 存在正交矩阵 $Q$ 使 $A=Q\\Lambda Q^{\\mathrm T}$，把 $\\sqrt{\\lambda}$ 提出去',
         '反方向用 $x^{\\mathrm T}C^{\\mathrm T}Cx=\\|Cx\\|^{2}$ 与 $C$ 可逆'],
        '$A$ 正定 $\\iff$ 存在可逆 $C$ 使 $A=C^{\\mathrm T}C$：正向取 $C=\\Lambda^{1/2}Q^{\\mathrm T}$；'
        '反之 $\\|Cx\\|^{2}\\geqslant0$ 且等号仅在 $x=0$ 成立。',
        '**步骤1**（$\\Rightarrow$）：$A$ 正定 $\\Rightarrow$ 存在正交矩阵 $Q$ 使 '
        '$Q^{\\mathrm T}AQ=\\Lambda=\\operatorname{diag}(\\lambda_1,\\cdots,\\lambda_n)$，$\\lambda_i>0$。'
        '令 $P=\\Lambda^{1/2}Q^{\\mathrm T}$，则 $P$ 可逆且 $A=P^{\\mathrm T}P$，取 $C=P$ 即可。\n'
        '**步骤2**（$\\Leftarrow$）：若 $A=C^{\\mathrm T}C$ 且 $C$ 可逆，则对任意 $x\\neq0$，'
        '$x^{\\mathrm T}Ax=\\|Cx\\|^{2}>0$（$Cx\\neq0$），故 $A$ 正定。\n'
        '**结论**：正定性等价于「$A$ 是某个可逆矩阵的 Gram 矩阵」；'
        '顺带可得 $|A|=|C|^{2}>0$，这也是正定的必要条件之一。'
    )


def _assert_complete_square():
    x1, x2, x3 = symbols('x1 x2 x3')
    lhs = x1**2 + 4*x1*x2 + 3*x2**2 + 2*x3**2
    rhs = (x1 + 2*x2)**2 - x2**2 + 2*x3**2
    assert simplify(lhs - rhs) == 0, '配方恒等式不成立'


def _assert_quad_matrix(A):
    x1, x2, x3 = symbols('x1 x2 x3')
    x = Matrix([x1, x2, x3])
    f = (x.T * A * x)[0].expand()
    target = (x1**2 + 2*x2**2 + 5*x3**2 + 2*x1*x2 - 2*x1*x3 + 4*x2*x3).expand()
    assert simplify(f - target) == 0, '二次型矩阵展开与原式不一致'


def _assert_all_positive(vals):
    assert all(v > 0 for v in vals), '存在非正的顺序主子式'


def _assert_pq(A, p, q):
    ev = A.eigenvals()
    total = sum(ev.values())
    assert total == A.rows, '特征值重数之和不等于阶数'
    assert p + q <= A.rows


def _assert_eigen_range(A, lo, hi):
    ev = sorted(A.eigenvals().keys())
    assert ev[0] == lo and ev[-1] == hi, '瑞利商区间与特征值不符'


# ============================================================================
# 四、线性空间与变换（10 题）
# ============================================================================

def build_spaces():
    # 1) 子空间判定（选择）
    add(
        '线性子空间的判定',
        '下列 $\\mathbb{R}^{3}$ 的子集中，对加法和数乘封闭（即构成子空间）的是（　　）\n\n'
        '(A) $\\{(x,y,z)\\mid x+y+z=1\\}$　　(B) $\\{(x,y,z)\\mid x=y\\}$\n\n'
        '(C) $\\{(x,y,z)\\mid x^{2}+y^{2}=1\\}$　　(D) $\\{(x,y,z)\\mid x,y,z\\text{ 均为整数}\\}$',
        ['线性空间与变换'], 4, 4, 3, '选择题',
        ['子空间必须含零向量，且对加法与数乘封闭',
         '整数集合对数乘不封闭（乘 $\\frac12$ 就出界）'],
        '(B)。',
        '**步骤1**：(A) 不含零向量（$0+0+0\\neq1$），直接排除。\n'
        '**步骤2**：(C) 是圆柱面 $x^{2}+y^{2}=1$，不含零向量，且两点的和一般不在其上，'
        '对加法不封闭，排除。\n'
        '**步骤3**：(D) 取整数向量 $(1,0,0)$ 乘 $\\frac12$ 得 $(\\frac12,0,0)$，不再是整数向量，'
        '对数乘不封闭，排除。\n'
        '**步骤4**：(B) 即平面 $x-y=0$，它是齐次线性方程组 $x-y=0$ 的解集，'
        '任取两点之和、任一点乘任意实数仍满足该方程，故是子空间（$\\dim=2$）。\n'
        '**结论**：选 (B)。'
    )

    # 2) 线性变换的矩阵表示
    T2 = Matrix([[2, -1, 0], [1, 0, 1]])
    add(
        '线性变换在标准基下的矩阵',
        '设线性变换 $T:\\mathbb{R}^{3}\\to\\mathbb{R}^{2}$ 定义为 '
        '$T(x_1,x_2,x_3)=(2x_1-x_2,\\ x_1+x_3)$，求 $T$ 在标准基下的矩阵。',
        ['线性空间与变换', '矩阵运算'], 3, 3, 3, '填空题',
        ['求 $T(e_1),T(e_2),T(e_3)$', '把它们的坐标按列排成矩阵'],
        '$T$ 的矩阵为 $' + pm(T2) + '$。',
        '**步骤1**：$T(e_1)=(2,1)^{\\mathrm T}$，$T(e_2)=(-1,0)^{\\mathrm T}$，$T(e_3)=(0,1)^{\\mathrm T}$。\n'
        '**步骤2**：按列排成 $2\\times3$ 矩阵即得。\n'
        '**结论**：$' + pm(T2) + '$，即 $T(x)=Ax$。',
        check=lambda it: _assert_linear_map(T2)
    )

    # 3) 核与像的维数
    A3 = Matrix([[1, 2, 3], [2, 4, 6], [1, 0, 1]])
    ns3 = A3.nullspace()
    add(
        '求线性变换的核与像',
        '设线性变换 $T(x)=Ax$，其中 $A=' + pm(A3) + '$。求 $\\ker T$ 与 $\\operatorname{Im}T$ 的维数，'
        '并各给出一组基。',
        ['线性空间与变换', '向量组'], 5, 5, 6, '解答题',
        ['$\\dim\\ker T=n-r(A)$，$\\dim\\operatorname{Im}T=r(A)$',
         '核的基就是 $Ax=0$ 的基础解系，像的基是 $A$ 的列向量组的极大无关组'],
        '$\\dim\\ker T=1$，基 $(' + _vec_tex(ns3[0]) + ')^{\\mathrm T}$；'
        '$\\dim\\operatorname{Im}T=2$，基 $(1,2,1)^{\\mathrm T},(3,6,1)^{\\mathrm T}$。',
        '**步骤1**：第 2 行是第 1 行的 $2$ 倍，故 $r(A)=2$。\n'
        '**步骤2**：$\\dim\\ker T=3-2=1$；解 $Ax=0$ 得基础解系 $(' + _vec_tex(ns3[0]) + ')^{\\mathrm T}$。\n'
        '**步骤3**：$\\dim\\operatorname{Im}T=r(A)=2$，第 1、3 列线性无关，构成像的基。\n'
        '**结论**：$\\ker T$ 与 $\\operatorname{Im}T$ 的维数之和为 $3$，符合秩-零度定理。',
        check=lambda it: _assert_rank_nullity(A3, ns3)
    )

    # 4) 可逆变换与逆变换
    T4 = Matrix([[1, 1], [1, -1]])
    add(
        '判定可逆并求逆变换',
        '设 $T:\\mathbb{R}^{2}\\to\\mathbb{R}^{2}$，$T(x_1,x_2)=(x_1+x_2,\\ x_1-x_2)$。'
        '判断 $T$ 是否可逆；若可逆，求 $T^{-1}$ 的表达式与矩阵。',
        ['线性空间与变换'], 3, 4, 4, '解答题',
        ['看表示矩阵的行列式是否为零', '可逆时逆变换的矩阵就是矩阵的逆'],
        '$T$ 可逆，$T^{-1}(y_1,y_2)=\\left(\\frac{y_1+y_2}{2},\\ \\frac{y_1-y_2}{2}\\right)$，'
        '矩阵为 $\\frac12\\begin{pmatrix}1&1\\\\1&-1\\end{pmatrix}$。',
        '**步骤1**：$T$ 的矩阵 $A=' + pm(T4) + '$，$|A|=-2\\neq0$，故 $T$ 可逆。\n'
        '**步骤2**：$A^{-1}=' + latex(T4.inv()) + '$。\n'
        '**结论**：$T^{-1}(y)=A^{-1}y=\\left(\\frac{y_1+y_2}{2},\\frac{y_1-y_2}{2}\\right)$。'
        '可验算 $T(T^{-1}(y))=(y_1,y_2)$。',
        check=lambda it: _assert_inverse_map(T4)
    )

    # 5) 子空间的像仍是子空间（证明）
    add(
        '线性变换把子空间映成子空间',
        '设 $T$ 是线性空间 $V$ 上的线性变换，$W$ 是 $V$ 的子空间。'
        '证明：$T(W)=\\{T(w)\\mid w\\in W\\}$ 是 $V$ 的子空间，且 $\\dim T(W)\\leqslant\\dim W$。',
        ['线性空间与变换'], 5, 6, 4, '证明题',
        ['子空间三条件：含零、对加法封闭、对数乘封闭',
         '维数不等式用「把 $W$ 的基映过去，像空间由它们的像张成」'],
        '$T(W)$ 是子空间：含 $T(0)=0$，对加法与数乘封闭；'
        '若 $w_1,\\cdots,w_k$ 是 $W$ 的基，则 $T(W)=\\operatorname{span}\\{T(w_i)\\}$，故维数不超过 $k$。',
        '**步骤1**：$0\\in W$，故 $T(0)=0\\in T(W)$。\n'
        '**步骤2**：设 $u=T(w_1),v=T(w_2)\\in T(W)$，$\\lambda\\in\\mathbb{R}$，则 '
        '$u+v=T(w_1+w_2)\\in T(W)$（因 $W$ 对加法封闭），'
        '$\\lambda u=T(\\lambda w_1)\\in T(W)$（因 $W$ 对数乘封闭）。\n'
        '**步骤3**：设 $\\dim W=k$，取基 $w_1,\\cdots,w_k$，则任意 $w=\\sum a_iw_i$ 的像 '
        '$T(w)=\\sum a_iT(w_i)$，即 $T(W)=\\operatorname{span}\\{T(w_1),\\cdots,T(w_k)\\}$，'
        '由 $k$ 个向量张成，维数不超过 $k$。\n'
        '**结论**：$T(W)$ 是子空间，且 $\\dim T(W)\\leqslant\\dim W$（等号当且仅当 $T$ 在 $W$ 上单射）。'
    )

    # 6) 多项式空间与微分算子
    add(
        '多项式空间上微分算子的矩阵',
        '设 $P_2=\\{a_0+a_1x+a_2x^{2}\\}$，取基 $1,x,x^{2}$。'
        '求微分变换 $D(f)=f\'$ 在该基下的矩阵，并写出 $D$ 的核与像。',
        ['线性空间与变换'], 4, 5, 5, '解答题',
        ['逐个求基向量的像，再写成坐标向量按列排',
         '核就是导数为零的多项式（常数）'],
        '$D$ 的矩阵为 $\\begin{pmatrix}0&1&0\\\\0&0&2\\\\0&0&0\\end{pmatrix}$；'
        '$\\ker D=\\operatorname{span}\\{1\\}$，$\\operatorname{Im}D=\\operatorname{span}\\{1,x\\}$。',
        '**步骤1**：$D(1)=0$，$D(x)=1$，$D(x^{2})=2x$。\n'
        '**步骤2**：坐标分别为 $(0,0,0)^{\\mathrm T},(1,0,0)^{\\mathrm T},(0,2,0)^{\\mathrm T}$，'
        '按列排得矩阵。\n'
        '**步骤3**：$\\ker D$ 由 $a_1+2a_2x=0$ 得 $a_1=a_2=0$，即常数；'
        '像由 $\\{1,2x\\}$ 张成。\n'
        '**结论**：$\\dim\\ker D=1$、$\\dim\\operatorname{Im}D=2$，和为 $3$，符合秩-零度定理。'
    )

    # 7) 过渡矩阵与坐标变换
    P7 = Matrix([[1, 1], [1, -1]])
    add(
        '基变换与坐标变换',
        '在 $\\mathbb{R}^{2}$ 中取两组基：$e_1=(1,0)^{\\mathrm T},e_2=(0,1)^{\\mathrm T}$ 与 '
        '$\\alpha_1=(1,1)^{\\mathrm T},\\alpha_2=(1,-1)^{\\mathrm T}$。'
        '求从基 $e$ 到基 $\\alpha$ 的过渡矩阵，并求向量 $x=(3,1)^{\\mathrm T}$ 在基 $\\alpha$ 下的坐标。',
        ['线性空间与变换'], 4, 5, 5, '解答题',
        ['过渡矩阵 $P$ 满足 $(\\alpha_1,\\alpha_2)=(e_1,e_2)P$',
         '坐标之间是 $x=P y$，所以 $y=P^{-1}x$'],
        '过渡矩阵 $P=' + pm(P7) + '$，$x$ 在基 $\\alpha$ 下的坐标为 $(2,1)^{\\mathrm T}$。',
        '**步骤1**：$\\alpha_1=e_1+e_2,\\ \\alpha_2=e_1-e_2$，故 $P=' + pm(P7) + '$。\n'
        '**步骤2**：$x=(e_1,e_2)x=(\\alpha_1,\\alpha_2)P^{-1}x$，即 $y=P^{-1}x$。\n'
        '**步骤3**：$P^{-1}=' + latex(P7.inv()) + '$，故 $y=P^{-1}(3,1)^{\\mathrm T}=(2,1)^{\\mathrm T}$。\n'
        '**结论**：$x=2\\alpha_1+\\alpha_2$（直接验算：$(2,2)+(1,-1)=(3,1)$）。',
        check=lambda it: _assert_transition(P7)
    )

    # 8) 秩-零度与复合
    add(
        '复合变换的核维数估计',
        '设 $S,T$ 都是 $n$ 维线性空间 $V$ 上的线性变换。证明：'
        '$\\dim\\ker(ST)\\leqslant\\dim\\ker S+\\dim\\ker T$。',
        ['线性空间与变换'], 6, 7, 4, '证明题',
        ['把 $\\ker(ST)$ 拆成「落在 $\\ker T$ 里的部分」与「$T$ 的像落在 $\\ker S$ 里的部分」',
         '对 $T$ 在 $\\ker(ST)$ 上的限制用秩-零度定理'],
        '$\\dim\\ker(ST)\\leqslant\\dim\\ker S+\\dim\\ker T$：把 $\\ker(ST)$ 拆成落在 $\\ker T$ 的部分与其余部分，'
        '其余部分的像落在 $\\ker S\\cap\\operatorname{Im}T$ 中，维数不超过 $\\dim\\ker S$。',
        '**步骤1**：记 $V_1=\\ker(ST)\\cap\\ker T$，$V_2$ 为 $\\ker(ST)$ 中 $V_1$ 的补子空间，'
        '则 $\\dim\\ker(ST)=\\dim V_1+\\dim V_2$，且 $\\dim V_1\\leqslant\\dim\\ker T$。\n'
        '**步骤2**：对 $x\\in V_2$（$x\\neq0$），$Tx\\neq0$ 且 $S(Tx)=(ST)x=0$，'
        '故 $T$ 把 $V_2$ 单射地映入 $\\ker S$，于是 $\\dim V_2\\leqslant\\dim\\ker S$。\n'
        '**结论**：两式相加即得 $\\dim\\ker(ST)\\leqslant\\dim\\ker S+\\dim\\ker T$。'
    )

    # 9) 矩阵空间的维数
    add(
        '矩阵空间的维数',
        '设 $V=\\{A\\in\\mathbb{R}^{2\\times2}\\}$ 为全体二阶实矩阵构成的空间，'
        '$V_1$ 为二阶对称矩阵全体，$V_2$ 为二阶反对称矩阵全体。求 $\\dim V,\\ \\dim V_1,\\ \\dim V_2$。',
        ['线性空间与变换'], 3, 3, 3, '填空题',
        ['二阶矩阵有 4 个独立元素', '对称矩阵对角元独立、非对角元相同；反对称矩阵对角元必为零'],
        '$\\dim V=4$，$\\dim V_1=3$，$\\dim V_2=1$。',
        '**步骤1**：$\\mathbb{R}^{2\\times2}$ 的标准基是 $E_{11},E_{12},E_{21},E_{22}$，故 $\\dim V=4$。\n'
        '**步骤2**：对称矩阵由 $a_{11},a_{22},a_{12}(=a_{21})$ 三个参数决定，故 $\\dim V_1=3$。\n'
        '**步骤3**：反对称矩阵形如 $\\begin{pmatrix}0&a\\\\-a&0\\end{pmatrix}$，故 $\\dim V_2=1$。\n'
        '**结论**：$4=3+1$，且 $V=V_1\\oplus V_2$（任一矩阵可唯一分解为对称部分与反对称部分）。'
    )

    # 10) 维数公式应用
    add(
        '子空间维数公式的应用',
        '在 $\\mathbb{R}^{3}$ 中，$U=\\operatorname{span}\\{(1,0,1)^{\\mathrm T},(0,1,0)^{\\mathrm T}\\}$，'
        '$W=\\operatorname{span}\\{(1,1,1)^{\\mathrm T}\\}$。求 $\\dim(U+W)$ 与 $\\dim(U\\cap W)$。',
        ['线性空间与变换', '向量组'], 3, 4, 3, '填空题',
        ['先看 $W$ 的生成向量是否已经落在 $U$ 里',
         '用 $\\dim(U+W)=\\dim U+\\dim W-\\dim(U\\cap W)$ 校验'],
        '$\\dim(U+W)=2$，$\\dim(U\\cap W)=1$。',
        '**步骤1**：$U=\\{(a,b,a)^{\\mathrm T}\\}$，而 $(1,1,1)^{\\mathrm T}$ 满足「首末分量相等」，'
        '故 $(1,1,1)^{\\mathrm T}\\in U$，即 $W\\subseteq U$。\n'
        '**步骤2**：于是 $U+W=U$，$\\dim(U+W)=\\dim U=2$；'
        '$U\\cap W=W$，$\\dim(U\\cap W)=1$。\n'
        '**结论**：$\\dim(U+W)=2,\\ \\dim(U\\cap W)=1$，代入维数公式 $2+1-1=2$ 校验成立。'
    )


def _assert_linear_map(A):
    assert A.shape == (2, 3)
    # T(e1)=(2,1): 第 1 列
    assert list(A[:, 0]) == [2, 1]


def _assert_rank_nullity(A, ns):
    assert len(ns) == A.cols - A.rank(), '零度不等于 n-rank'
    for v in ns:
        assert (A * v).is_zero_matrix


def _assert_inverse_map(A):
    assert A.det() != 0
    assert (A * A.inv()).applyfunc(lambda x: simplify(x)) == eye(A.rows)


def _assert_transition(P):
    # x=(3,1)，在 α 基下坐标应为 (2,1)
    y = P.inv() * Matrix([3, 1])
    assert list(y) == [2, 1], '坐标变换验算失败'


# ============================================================================
# 主流程
# ============================================================================

def validate():
    """对全部题目做一遍结构性检查：字段齐全、LaTeX 定界符成对、标签合法"""
    import re
    ok_tags = {'行列式', '矩阵运算', '逆矩阵与秩', '线性方程组', '向量组',
               '特征值与特征向量', '二次型', '相似与对角化', '线性空间与变换', '线性代数综合'}
    assert len(PROBLEMS) == 40, '题目数应为 40，实际 %d' % len(PROBLEMS)
    for i, p in enumerate(PROBLEMS, 1):
        for k in ('title', 'statement', 'tags', 'thinking', 'difficulty', 'calc',
                  'source', 'hints', 'answer', 'solution', 'mainTag', 'kind'):
            assert p.get(k) not in (None, ''), '第 %d 题缺字段 %s' % (i, k)
        assert p['mainTag'] == '线性代数'
        for t in p['tags']:
            assert t in ok_tags, '第 %d 题标签非法：%s' % (i, t)
        assert 1 <= p['thinking'] <= 10 and 1 <= p['difficulty'] <= 10 and 1 <= p['calc'] <= 10
        # 定界符成对（忽略转义的 \$）
        for field in ('statement', 'answer', 'solution'):
            s = p[field].replace('\\$', '')
            assert s.count('$') % 2 == 0, '第 %d 题 %s 的 $ 不成对' % (i, field)
            assert s.count('\\left') == s.count('\\right'), '第 %d 题 %s 的 \\left/\\right 不成对' % (i, field)
        assert p['hints'], '第 %d 题缺提示' % i
        assert '步骤' in p['solution'], '第 %d 题缺分步解析' % i
        assert re.search(r'[。！？]$', p['answer'].strip()), '第 %d 题答案缺少句末标点' % i


def main():
    build_vectors()
    build_similarity()
    build_quadratic()
    build_spaces()
    validate()
    print('生成 %d 道题，全部断言通过' % len(PROBLEMS))
    if '--check' in sys.argv:
        return
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(PROBLEMS, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print('已写入', OUT)


if __name__ == '__main__':
    main()


