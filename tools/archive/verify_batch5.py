"""第五批（期中卷 + 三角/有理分式）答案校验"""
import sympy as sp

x, y, t, th = sp.symbols('x y t theta', real=True)

print('E4  (x^2+1)/(x+1) - ax - b 的 a,b')
a, b = sp.symbols('a b')
expr = (x**2 + 1)/(x + 1) - a*x - b
lim_inf = sp.limit(expr, x, sp.oo)
print('  取 a=1,b=-3/2 时极限 =', lim_inf.subs({a: 1, b: -sp.Rational(3, 2)}))

print('\nE5  sin(tan x) - tan(sin x) 的主部')
f = sp.sin(sp.tan(x)) - sp.tan(sp.sin(x))
print('  级数:', sp.series(f, x, 0, 11))
print('  主部/阶数:', sp.limit(f/x**5, x, 0))

print('\nE7  r=e^th 的 d2y/dx2')
r = sp.exp(th)
X, Y = r*sp.cos(th), r*sp.sin(th)
d1 = sp.diff(Y, th)/sp.diff(X, th)
d2 = sp.simplify(sp.diff(d1, th)/sp.diff(X, th))
print('  dy/dx =', sp.simplify(d1))
print('  d2y/dx2 =', sp.simplify(d2))

print('\nE10 y=[f(x^2)]^(1/f(x)) 的 dy|_(x=1), f(1)=2, f\'(1)=1')
F = sp.Function('f')
Y2 = F(x**2)**(1/F(x))
lnY = sp.log(F(x**2))/F(x)
dln = sp.diff(lnY, x)
val = dln.subs({F(1): 2, sp.Subs(sp.Derivative(F(x), x), x, 1): 1})
print('  (ln y)\'|1 =', sp.simplify(val))
print('  y\'|1 = sqrt2 * (2-ln2)/4 =', sp.nsimplify(sp.sqrt(2)*(2-sp.log(2))/4), '≈', sp.N(sp.sqrt(2)*(2-sp.log(2))/4))

print('\nE11 f(x)/x = 3x - sinx + o(x)  =>  f(x)/x^2 极限')
print('  lim (3x^2 - x sin x)/x^2 =', sp.limit((3*x**2 - x*sp.sin(x))/x**2, x, 0))

print('\nE12 隐函数 f^3+f=x+2, f(0)=1, 求 d2x/dy2|y=1')
fv = sp.Function('fv')
eq = sp.Eq(fv(x)**3 + fv(x), x + 2)
# sympy 的 idiff 在新版本里不接受 Eq 对象，要传 lhs-rhs 表达式
fp = sp.idiff(eq.lhs - eq.rhs, fv(x), x)          # f'
fpp = sp.diff(fp, x).subs(sp.Derivative(fv(x), x), fp)
val1 = {fv(x): 1}
fp1 = sp.simplify(fp.subs(val1))
fpp1 = sp.simplify(fpp.subs(val1).subs(sp.Derivative(fv(x), x), fp1))
print('  f\'(0)=', fp1, ' f\'\'(0)=', fpp1)
print('  d2x/dy2 = -f\'\'/f\'^3 =', sp.simplify(-fpp1/fp1**3))

print('\nE13 圆锥漏斗: H=24, R=6, 水深16, dh/dt=-2')
h = sp.symbols('h', positive=True)
rr = 6*(1 - h/24)
print('  h=16 时 r =', rr.subs(h, 16))
dV = sp.pi*rr**2*sp.Rational(-2)
print('  dV/dt =', sp.simplify(dV.subs(h, 16)))
print('  圆柱 R=6: dH/dt =', sp.simplify(dV.subs(h, 16)/(sp.pi*36)))

print('\n积分 1/(5+2cos x)')
ans = 2/sp.sqrt(21)*sp.atan(sp.sqrt(sp.Rational(3, 7))*sp.tan(x/2))
print('  求导验证:', sp.simplify(sp.diff(ans, x) - 1/(5 + 2*sp.cos(x))))

print('\n积分 (3x^2+2x+4)/(x(x^2+2))')
ans2 = 2*sp.log(sp.Abs(x)) + sp.Rational(1, 2)*sp.log(x**2 + 2) + sp.sqrt(2)*sp.atan(x/sp.sqrt(2))
print('  求导验证:', sp.simplify(sp.diff(ans2, x) - (3*x**2 + 2*x + 4)/(x*(x**2 + 2))))

print('\n三角分式 (2sinx+7cosx)/(4sinx-cosx)')
ans3 = sp.Rational(1, 17)*x + sp.Rational(30, 17)*sp.log(sp.Abs(4*sp.sin(x) - sp.cos(x)))
print('  求导验证:', sp.simplify(sp.diff(ans3, x) - (2*sp.sin(x) + 7*sp.cos(x))/(4*sp.sin(x) - sp.cos(x))))
