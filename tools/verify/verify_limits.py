"""极限题答案的数值验证（避开符号计算，直接取近似极限）

接近极限点时容易出现两种数值事故：
1) 幂次 1/x 很大导致 float 溢出/下溢；
2) sqrt(x±1)-2sqrt(x) 这类相近数相减发生灾难性抵消。
统一改用 mpmath 的 50 位精度，并对幂塔取对数计算。
"""
import math
import mpmath as mp

mp.mp.dps = 50

_FAILS = []


def show(name, val, expect, tol=1e-3):
    val = mp.mpf(val)
    expect = mp.mpf(expect)
    ok = abs(val - expect) < max(mp.mpf(tol), abs(expect) * mp.mpf(tol))
    if not ok:
        _FAILS.append(name)
    print(('  OK  ' if ok else '  FAIL ') +
          f'{name}: {mp.nstr(val, 10)} vs {mp.nstr(expect, 10)}')


# i1-1: ((a^{x^2}+b^{x^2})/(a^x+b^x))^{1/x} -> 1/sqrt(ab)
a, b = mp.mpf(2), mp.mpf(8)
for x in (mp.mpf('0.001'), mp.mpf('0.0005')):
    base = (a ** (x * x) + b ** (x * x)) / (a ** x + b ** x)
    show(f'i1-1 x={x}', base ** (1 / x), 1 / mp.sqrt(a * b))

# i1-3: prod_{i=2..n}[1-(x-1)^{1/i}] / (x-2)^{n-1} -> (-1)^{n-1}/n!
for n in (4, 6):
    x = 2 + 1e-7
    p = 1.0
    for i in range(2, n + 1):
        p *= 1 - (x - 1) ** (1 / i)
    expect = (-1) ** (n - 1) / math.factorial(n)
    show(f'i1-3 n={n}', p / (x - 2) ** (n - 1), expect, 1e-2)

# i1-4: tan^2 x/(1-cos x^2) * (1-sqrt(cos x))
for x in (1e-3, 5e-4):
    v = (math.tan(x) ** 2) / (1 - math.cos(x * x)) * (1 - math.sqrt(math.cos(x)))
    show(f'i1-4 x={x}', v, 0.5)

# i1-5: ln(sin x)/(pi-2x)^2
x = math.pi / 2 - 1e-5
show('i1-5', math.log(math.sin(x)) / (math.pi - 2 * x) ** 2, -0.125, 1e-3)

# i1-6: (pi/2 - arctan x)^{1/ln x}
x = mp.mpf('1e7')
show('i1-6', (mp.pi / 2 - mp.atan(x)) ** (1 / mp.log(x)), 1 / mp.e)

# i1-7: sin(pi sqrt(n^2+1)) -> 0
for n in (1000, 10000):
    # 直接 float 会把 π·n 与微小增量一起算丢；主部是 π/(2n)，不是 0
    show(f'i1-7 n={n}', mp.sin(mp.pi * mp.sqrt(n * n + 1)),
         mp.pi / (2 * n), 1e-3)

# i2-1: (1-prod cos kx)/(sin x ln(1+x)) -> sum k^2 / 2
for n in (3, 5):
    for x in (1e-4, 5e-5):
        prod = 1.0
        for k in range(1, n + 1):
            prod *= math.cos(k * x)
        v = (1 - prod) / (math.sin(x) * math.log(1 + x))
        expect = sum(k * k for k in range(1, n + 1)) / 2
        show(f'i2-1 n={n} x={x}', v, expect)

# i2-2: (cos x)^{1/sin^2 x} -> e^{-1/2}
x = 1e-3
show('i2-2', math.cos(x) ** (1 / math.sin(x) ** 2), math.exp(-0.5))

# i2-3: (sin 2x + cos 2x)^{1/x} -> e^2
for x in (1e-4, 1e-5):
    show(f'i2-3 x={x}', (math.sin(2 * x) + math.cos(2 * x)) ** (1 / x), math.exp(2))

# i2-5: (2tan x/(x+sin x))^{1/(x*((1+3x)^{1/3}-1))} -> e^{5/12}
for x in (mp.mpf('0.001'), mp.mpf('0.0001')):
    base = 2 * mp.tan(x) / (x + mp.sin(x))
    power = 1 / (x * ((1 + 3 * x) ** (mp.mpf(1) / 3) - 1))
    # base^power 会让 float 溢出，取对数后再指数化
    show(f'i2-5 x={x}', mp.e ** (power * mp.log(base)), mp.e ** (mp.mpf(5) / 12))

# i2-6: x^{3/2}(sqrt(x-1)-2sqrt x+sqrt(x+1)) -> -1/4
x = mp.mpf('1e8')
# sqrt(x±1)-2sqrt(x) 在 float 下互相抵消成 0；50 位精度才能留住主部
v = x ** mp.mpf('1.5') * (mp.sqrt(x - 1) - 2 * mp.sqrt(x) + mp.sqrt(x + 1))
show('i2-6', v, -0.25, 1e-2)

# i2-8: sum 1/sqrt(n^2+i) -> 1
n = 100000
s = sum(1 / math.sqrt(n * n + i) for i in range(1, n + 1))
show(f'i2-8 n={n}', s, 1.0)

# 被标注为存疑的两题：看看是否真的发散
print('\n[存疑] i2-4: (e^x - x^2)^{1/sin^3 x} 在 x->0 两侧')
for x in (mp.mpf('0.001'), mp.mpf('-0.001')):
    base = mp.e ** x - x * x
    power = 1 / mp.sin(x) ** 3
    val = mp.e ** (power * mp.log(base)) if base > 0 else mp.nan
    print(f'  x={mp.nstr(x, 4)}: {mp.nstr(val, 8)}')

print('\n[存疑] i2-7: (x e^{x/2} - sin x)/(x^2 sin x) 在 x->0 两侧')
for x in (mp.mpf('0.001'), mp.mpf('-0.001')):
    num = x * mp.e ** (x / 2) - mp.sin(x)
    den = x * x * mp.sin(x)
    print(f'  x={mp.nstr(x, 4)}: {mp.nstr(num / den, 8)}')

# CI / 入库门禁用：show() 里有 FAIL 就非零退出
import sys as _sys
if _FAILS:
    print('未通过用例:', _FAILS)
_sys.exit(1 if _FAILS else 0)
