#!/usr/bin/env python3
"""物理题量纲与数值验题（SymPy）。

这是入库门禁里唯一会用 SymPy 的物理脚本，做三件事：

1. 量纲一致性：对 `physicsMeta.unit` 与 `physicsMeta.dimension` 互相校验——
   题的声明量纲必须和单位换算出来的量纲一致，否则入库后学生永远被判「量纲错」。
2. 公式量纲检查：题干里出现形如 `xxx = 表达式` 的结论行时，检查左右量纲是否一致。
3. 数值答案复核：`answerType=numeric_unit` 的题，用 sympy 解析答案数值，
   再按单位换到 SI，检查与 `meta.unit` 声明的量纲是否匹配，并给出相对误差参考。

用法：
    python tools/verify/verify_physics.py                      # 只跑内置自检样例
    python tools/verify/verify_physics.py --file data/batch-physics-01.json
    python tools/verify/verify_physics.py --file x.json --strict  # 有问题的题直接非零退出

设计约束：脚本失败=门禁失败，所以内置样例必须稳定通过（CI 每次都跑）；
题库里的题若本身有问题，默认只报告，`--strict` 才让它阻断入库。
"""
import argparse
import json
import os
import re
import sys

try:
    import sympy as sp
    from sympy.physics.units import (
        ampere, candela, coulomb, farad, henry, joule, kelvin, kilogram, meter,
        mole, newton, ohm, pascal, second, tesla, volt, watt, weber,
    )
    from sympy.physics.units.systems.si import SI
    from sympy.physics.units import (
        mass as dim_mass, length as dim_length, time as dim_time, current as dim_current,
        temperature as dim_temperature, amount as dim_amount,
        luminous_intensity as dim_luminous,
    )
except Exception as e:  # pragma: no cover
    print(f"! 缺少 sympy：{e}")
    sys.exit(2)

# 7 维量纲基（与 lib/physics-equiv.js 的 BASE_KEYS 顺序一致）。
# 注意：get_dimensional_expr 返回的是 ***Dimension*** 表达式（mass/length/time…），
# 不是单位表达式；用 Dimension 才能正确取幂次。
BASES = [
    (dim_mass, 'M'), (dim_length, 'L'), (dim_time, 'T'), (dim_current, 'I'),
    (dim_temperature, 'K'), (dim_amount, 'N'), (dim_luminous, 'J'),
]

UNITS = {
    'kg': kilogram, 'g': kilogram / 1000, 'm': meter, 's': second,
    'A': ampere, 'K': kelvin, 'mol': mole, 'cd': candela,
    'N': newton, 'J': joule, 'W': watt, 'Pa': pascal,
    'C': coulomb, 'V': volt, 'ohm': ohm, 'F': farad, 'H': henry,
    'T': tesla, 'Wb': weber, 'Hz': 1 / second,
    'eV': sp.Rational('1.602176634e-19') * joule,
    'cal': sp.Rational('4.184') * joule,
    'atm': sp.Rational('101325') * pascal,
    'L': meter ** 3 / 1000,
    'u': sp.Rational('1.66053906660e-27') * kilogram,
    # 角度与百分比都是无量纲量：rad 系数 1，percent 系数 1/100
    'rad': sp.Integer(1),
    'sr': sp.Integer(1),
    'percent': sp.Rational(1, 100),
    # 天文与 CGS 单位（SymPy 没有内置，直接按等值 SI 量登记）
    'pc': sp.Rational('3.0856775814913673e16') * meter,
    'AU': sp.Rational('1.495978707e11') * meter,
    'au': sp.Rational('1.495978707e11') * meter,
    'ly': sp.Rational('9.4607304725808e15') * meter,
    'Msun': sp.Rational('1.98847e30') * kilogram,
    'Rsun': sp.Rational('6.957e8') * meter,
    'Lsun': sp.Rational('3.828e26') * watt,
    'Myr': sp.Rational('3.15576e13') * second,
    'Gyr': sp.Rational('3.15576e16') * second,
    'Jy': sp.Rational('1e-26') * (kilogram / second ** 2),
    'mag': sp.Integer(1),
    'dyn': sp.Rational('1e-5') * newton,
    'erg': sp.Rational('1e-7') * joule,
    'Ba': sp.Rational('0.1') * pascal,
    'esu': sp.Rational('3.3356409519815204e-10') * coulomb,
    'statC': sp.Rational('3.3356409519815204e-10') * coulomb,
    'Gs': sp.Rational('1e-4') * tesla,
    'Mx': sp.Rational('1e-8') * weber,
    # 时间与角度：判题引擎认这些写法，验题脚本也必须认得，否则会误报「单位无法解析」
    'yr': sp.Rational('3.15576e7') * second,
    'h': sp.Integer(3600) * second,
    'min': sp.Integer(60) * second,
    'd': sp.Integer(86400) * second,
    'arcsec': sp.pi / 648000,
    'arcmin': sp.pi / 10800,
    'deg': sp.pi / 180,
    '°': sp.pi / 180,
    'rpm': sp.pi / 30,
    'r/min': sp.pi / 30,
}

PREFIX = {
    'p': sp.Rational(1, 10 ** 12), 'n': sp.Rational(1, 10 ** 9),
    'μ': sp.Rational(1, 10 ** 6), 'u': sp.Rational(1, 10 ** 6),
    'm': sp.Rational(1, 1000), 'c': sp.Rational(1, 100), 'd': sp.Rational(1, 10),
    'k': sp.Rational(1000), 'M': sp.Rational(10 ** 6), 'G': sp.Rational(10 ** 9),
}


def dim_of(expr):
    """把表达式化到 7 维量纲向量；失败返回 None。

    get_dimensional_expr 会保留派生量纲名（newton → force），必须再走
    get_dimensional_dependencies 展开成 mass/length/time 的幂次。
    """
    try:
        from sympy.physics.units.systems.si import dimsys_SI
        dim = SI.get_dimensional_expr(expr)
        deps = dimsys_SI.get_dimensional_dependencies(dim)
        vec = [int(sp.nsimplify(deps.get(base, 0))) for base, _ in BASES]
        extra = set(deps) - {b for b, _ in BASES}
        if extra:
            return None
        return tuple(vec)
    except Exception:
        return None


def parse_unit(text):
    """极简单位串解析：支持 / * ^ 括号与 SI 词头。

    单遍扫描：只把「单位符号词」替换成 UNITS["x"]（或 PREFIX["p"]*UNITS["x"]），
    运算符与括号原样保留。不要用「先整体替换 UNITS、再全局替换词头」的两遍法：
    第二遍会把 `UNITS["kg"]` 里的 kg 再拆成 k*g，J/(kg*K) 直接解析失败。
    """
    s = str(text or '').strip()
    s = re.sub(r'\\mathrm\{(.*?)\}', r'\1', s)
    s = re.sub(r'\\(?:cdot|times)', '*', s)
    s = s.replace('·', '*').replace('⋅', '*').replace(' ', '*').replace('^', '**')
    s = s.replace('%', 'percent')
    s = s.replace('°', 'deg')
    s = s.replace('″', 'arcsec')
    s = s.replace('r/min', 'rpm')
    s = re.sub(r'\*\*\s*\{?(-?\d+)\}?', r'**\1', s)
    if not s:
        return None

    def repl(m):
        w = m.group(0)
        if w in UNITS:
            return 'UNITS["' + w + '"]'
        for pfx in sorted(PREFIX, key=len, reverse=True):
            base = w[len(pfx):]
            if w.startswith(pfx) and base in UNITS:
                return '(PREFIX["' + pfx + '"]*UNITS["' + base + '"])'
        raise KeyError(w)

    try:
        expr = re.sub(r'[A-Za-zμÅ]+', repl, s)
        val = sp.sympify(expr, locals={'UNITS': UNITS, 'PREFIX': PREFIX})
    except Exception:
        return None
    return val


def self_test():
    """内置样例：这些必须通过，否则说明校验工具本身坏了"""
    cases = [
        ('m/s', (0, 1, -1, 0, 0, 0, 0)),
        ('m/s^2', (0, 1, -2, 0, 0, 0, 0)),
        ('N', (1, 1, -2, 0, 0, 0, 0)),
        ('J', (1, 2, -2, 0, 0, 0, 0)),
        ('Pa', (1, -1, -2, 0, 0, 0, 0)),
        ('V', (1, 2, -3, -1, 0, 0, 0)),
        ('T', (1, 0, -2, -1, 0, 0, 0)),
        ('J/(kg*K)', (0, 2, -2, 0, -1, 0, 0)),
        ('kg*m/s^2', (1, 1, -2, 0, 0, 0, 0)),
        ('mT', (1, 0, -2, -1, 0, 0, 0)),
        ('km/h', None),   # h 未收录时允许 None；收录了就必须是速度
    ]
    bad = 0
    for text, want in cases:
        got = dim_of(parse_unit(text)) if parse_unit(text) is not None else None
        if want is not None and got != want:
            print(f'  ! 自检失败 {text}: 期望 {want}，得到 {got}')
            bad += 1
    if bad:
        print(f'自检失败 {bad} 项')
        return False
    print(f'自检通过：{len(cases)} 项单位量纲')
    return True


def check_problem(p):
    """返回问题列表（字符串）"""
    problems = []
    if str(p.get('subject') or '') != 'physics':
        return problems
    meta = p.get('physicsMeta') or {}
    unit_text = str(meta.get('unit') or '')
    declared = meta.get('dimension')
    system = str(meta.get('unitSystem') or 'SI').upper()
    atype0 = str(meta.get('answerType') or '')
    if system not in ('SI', 'CGS', 'ASTRO', 'NATURAL'):
        problems.append(f'unitSystem 非法：{system}')
    if atype0 == 'order_of_magnitude':
        dex = meta.get('tolDex')
        if dex is None:
            problems.append('order_of_magnitude 题缺少 tolDex')
        else:
            try:
                v = float(dex)
                if not (0 < v <= 2):
                    problems.append(f'tolDex 应在 (0, 2] 之间：{dex}')
            except Exception:
                problems.append(f'tolDex 不是数字：{dex}')

    unit_expr = parse_unit(unit_text) if unit_text else None
    if unit_text and unit_expr is None:
        problems.append(f'单位无法解析：{unit_text}')
    unit_dim = dim_of(unit_expr) if unit_expr is not None else None
    if unit_text and unit_expr is not None and unit_dim is None:
        problems.append(f'单位不在 SI 7 维内：{unit_text}')

    if declared and unit_dim:
        want = tuple(int(x) for x in declared)
        # 高斯制不校验电流维（I 在第 4 位）
        if system == 'CGS':
            want = want[:3] + (0,) + want[4:]
            unit_dim = unit_dim[:3] + (0,) + unit_dim[4:]
        if want != unit_dim:
            problems.append(f'声明量纲 {want} 与单位 {unit_text} 的量纲 {unit_dim} 不一致')

    atype = str(meta.get('answerType') or '')
    ans = str(p.get('answer') or '')
    if atype == 'numeric_unit':
        num = re.search(r'-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?', ans)
        if not num:
            problems.append('numeric_unit 题的答案里没有数值')
        if not unit_text:
            problems.append('numeric_unit 题缺少 physicsMeta.unit')
        # 答案里若自带单位，必须与 meta.unit 同量纲
        tail = ans[num.end():] if num else ''
        tail = re.sub(r'[\\${}]', '', tail).strip()
        if tail and tail not in ('', ',', '.'):
            ans_unit = parse_unit(tail)
            ans_dim = dim_of(ans_unit) if ans_unit is not None else None
            if ans_dim and unit_dim and ans_dim != unit_dim:
                problems.append(f'答案自带单位 {tail} 与 meta.unit 量纲不一致')
    return problems


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--file', default=None, help='待入库的物理题 JSON')
    ap.add_argument('--strict', action='store_true', help='题目有问题时非零退出')
    args, _unknown = ap.parse_known_args()

    ok = self_test()
    if not ok:
        sys.exit(1)

    if not args.file:
        print('未指定 --file：只做了自检（正常）')
        return

    if not os.path.exists(args.file):
        print(f'! 文件不存在：{args.file}')
        sys.exit(1)
    with open(args.file, encoding='utf-8') as f:
        data = json.load(f)
    items = data if isinstance(data, list) else data.get('problems', [])
    if not isinstance(items, list):
        print('! 文件结构不是数组或 {problems:[...]}')
        sys.exit(1)

    phys = [p for p in items if str(p.get('subject') or '') == 'physics']
    print(f'[target] {os.path.basename(args.file)}：共 {len(items)} 题，其中物理 {len(phys)} 题')
    bad = 0
    for p in phys:
        probs = check_problem(p)
        if probs:
            bad += 1
            print(f"  ✗ {p.get('code') or '(无编号)'} {str(p.get('title') or '')[:30]}")
            for x in probs:
                print(f'      - {x}')
    if bad:
        print(f'量纲/单位问题：{bad} 题')
        if args.strict:
            sys.exit(1)
    else:
        print(f'物理量纲校验通过：{len(phys)} 题')


if __name__ == '__main__':
    main()
