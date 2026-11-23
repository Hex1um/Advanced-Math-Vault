"""逐题校验不定积分：对答案求导，与积分函数比较（符号 + 数值双重）"""
import sympy as sp

x = sp.Symbol('x', positive=True, real=True)
t = sp.Symbol('t')
S = sp.sqrt

def L(v):
    return sp.log(sp.Abs(v))

cases = []

# ---------- 手写 左列 ----------
cases.append(('H1 ∫x·arcsin x dx',
    x*sp.asin(x),
    (2*x**2-1)/4*sp.asin(x) + x/4*S(1-x**2)))

cases.append(('H2 ∫e^{√x} dx',
    sp.exp(S(x)),
    2*(S(x)-1)*sp.exp(S(x))))

cases.append(('H3 ∫dx/(√x(1+∛x))',
    1/(S(x)*(1+x**sp.Rational(1,3))),
    6*(x**sp.Rational(1,6) - sp.atan(x**sp.Rational(1,6)))))

cases.append(('H4 ∫x e^x/√(e^x-1) dx',
    x*sp.exp(x)/S(sp.exp(x)-1),
    2*x*S(sp.exp(x)-1) - 4*S(sp.exp(x)-1) + 4*sp.atan(S(sp.exp(x)-1))))

cases.append(('H5 ∫arcsin(e^x)/e^x dx',
    sp.asin(sp.exp(x))/sp.exp(x),
    -sp.exp(-x)*sp.asin(sp.exp(x)) - L(sp.exp(-x)+S(sp.exp(-2*x)-1))))

cases.append(('H6 ∫arcsin x/(1+x²)^{3/2} dx',
    sp.asin(x)/(1+x**2)**sp.Rational(3,2),
    x*sp.asin(x)/S(1+x**2) - sp.asin(x**2)/2))

cases.append(('H7 ∫dx/(x^3+x)',
    1/(x**3+x),
    L(x) - L(x**2+1)/2))

cases.append(('H7b ∫dx/(x^5+x)',
    1/(x**5+x),
    L(x) - L(x**4+1)/4))

cases.append(('H8 ∫(1+x)/(x(1+x e^x)) dx',
    (1+x)/(x*(1+x*sp.exp(x))),
    x + L(x) - L(1+x*sp.exp(x))))

# ---------- 手写 右列 ----------
cases.append(('R1 ∫(x²+4)/(x+x⁴) dx',
    (x**2+4)/(x+x**4),
    4*L(x) - sp.Rational(4,3)*L(1+x**3) - sp.Rational(1,3)*L(1+x)
    + sp.Rational(1,6)*L(x**2-x+1) + 1/S(3)*sp.atan((2*x-1)/S(3))))

cases.append(('R3 ∫dx/√((x+a)(x+b))  (a=-2,b=3)',
    1/S((x-2)*(x+3)),
    L(x+sp.Rational(1,2) + S((x-2)*(x+3)))))

cases.append(('R4 ∫dx/(x√(x²-2x-3))',
    1/(x*S(x**2-2*x-3)),
    -sp.asin((x+3)/(2*x))/S(3)))

cases.append(('R5 ∫dx/(x+√(x²+2x+2))',
    1/(x+S(x**2+2*x+2)),
    S(x**2+2*x+2)/2 + L((S(x**2+2*x+2)-1)/(S(x**2+2*x+2)+1))/4 - x/2 + L(x+1)/2))

cases.append(('R6 ∫x√(x²+2x+2) dx',
    x*S(x**2+2*x+2),
    (x**2+2*x+2)**sp.Rational(3,2)/3 - (x+1)/2*S(x**2+2*x+2) - L(x+1+S(x**2+2*x+2))/2))

cases.append(('R7 ∫dx/(sin³x cos³x)',
    1/(sp.sin(x)**3*sp.cos(x)**3),
    2*sp.log(sp.tan(x)) - 2*sp.cos(2*x)/sp.sin(2*x)**2))

# R2 需要先做代换，单独校验：F(u) 对 x 求导，u=x/(1+x³)^{1/3}
u = x/(1+x**3)**sp.Rational(1,3)
cases.append(('R2 ∫dx/∛(1+x³)',
    1/(1+x**3)**sp.Rational(1,3),
    -L(1-u)/3 + L(u**2+u+1)/6 + 1/S(3)*sp.atan((2*u+1)/S(3))))

# ---------- 印刷题 ----------
cases.append(('P1 ∫x²ln(x+√(1+x²)) dx',
    x**2*sp.log(x+S(1+x**2)),
    x**3/3*sp.log(x+S(1+x**2)) - (1+x**2)**sp.Rational(3,2)/9 + S(1+x**2)/3))

cases.append(('P2 ∫(x²+2)/(x²+x+1)² dx',
    (x**2+2)/(x**2+x+1)**2,
    4/S(3)*sp.atan((2*x+1)/S(3)) + (x+1)/(x**2+x+1)))

cases.append(('P3 ∫sin x/(sin x-2cos x+2) dx',
    sp.sin(x)/(sp.sin(x)-2*sp.cos(x)+2),
    sp.Rational(4,5)*sp.log(2*sp.sin(x/2)+sp.cos(x/2)) + x/5))

cases.append(('P4 ∫x ln x/(1+x²)² dx',
    x*sp.log(x)/(1+x**2)**2,
    -sp.log(x)/(2*(1+x**2)) + sp.log(x)/2 - sp.log(1+x**2)/4))

cases.append(('P5 ∫e^x(x²+1)/(x+1)² dx',
    sp.exp(x)*(x**2+1)/(x+1)**2,
    sp.exp(x)*(x-1)/(x+1)))

ok = 0
bad = []
for name, f, F in cases:
    diff = sp.simplify(sp.diff(F, x) - f)
    sym_ok = diff == 0
    # 数值兜底
    num_ok = False
    if not sym_ok:
        pts = [sp.Rational(7,2), sp.Rational(5,2), sp.Rational(12,5), sp.Rational(4,3)]
        try:
            vals = [(abs(complex(sp.N(diff.subs(x, p)))) if diff.has(x) else abs(complex(sp.N(diff)))) for p in pts]
            num_ok = all(v < 1e-8 for v in vals)
        except Exception as e:
            num_ok = False
    if sym_ok or num_ok:
        ok += 1
        print(f'  ✓ {name}' + ('' if sym_ok else '  (数值校验通过)'))
    else:
        bad.append(name)
        print(f'  ✗ {name}   residual={sp.simplify(diff)}')

print(f'\n{ok}/{len(cases)} 通过')
if bad:
    print('未通过:', bad)
