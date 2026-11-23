"""极限题答案的数值验证（避开符号计算，直接取近似极限）"""
import math


def show(name, val, expect, tol=1e-3):
    ok = abs(val - expect) < max(tol, abs(expect) * tol)
    print(('  OK  ' if ok else '  FAIL ') + f'{name}: {val:.6f} vs {expect:.6f}')


# i1-1: ((a^{x^2}+b^{x^2})/(a^x+b^x))^{1/x} -> 1/sqrt(ab)
a, b = 2.0, 8.0
for x in (1e-3, 5e-4):
    base = (a ** (x * x) + b ** (x * x)) / (a ** x + b ** x)
    show(f'i1-1 x={x}', base ** (1 / x), 1 / math.sqrt(a * b))

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
x = 1e7
show('i1-6', (math.pi / 2 - math.atan(x)) ** (1 / math.log(x)), 1 / math.e)

# i1-7: sin(pi sqrt(n^2+1)) -> 0
for n in (1000, 10000):
    show(f'i1-7 n={n}', math.sin(math.pi * math.sqrt(n * n + 1)), 0.0, 1e-3)

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
for x in (1e-3, 1e-4):
    base = 2 * math.tan(x) / (x + math.sin(x))
    power = 1 / (x * ((1 + 3 * x) ** (1 / 3) - 1))
    show(f'i2-5 x={x}', base ** power, math.exp(5 / 12))

# i2-6: x^{3/2}(sqrt(x-1)-2sqrt x+sqrt(x+1)) -> -1/4
x = 1e8
v = x ** 1.5 * (math.sqrt(x - 1) - 2 * math.sqrt(x) + math.sqrt(x + 1))
show('i2-6', v, -0.25, 1e-2)

# i2-8: sum 1/sqrt(n^2+i) -> 1
n = 100000
s = sum(1 / math.sqrt(n * n + i) for i in range(1, n + 1))
show(f'i2-8 n={n}', s, 1.0)

# 被标注为存疑的两题：看看是否真的发散
print('\n[存疑] i2-4: (e^x - x^2)^{1/sin^3 x} 在 x->0 两侧')
for x in (1e-3, -1e-3):
    base = math.exp(x) - x * x
    val = base ** (1 / math.sin(x) ** 3) if base > 0 else float('nan')
    print(f'  x={x}: {val:.4g}')

print('\n[存疑] i2-7: (x e^{x/2} - sin x)/(x^2 sin x) 在 x->0 两侧')
for x in (1e-3, -1e-3):
    num = x * math.exp(x / 2) - math.sin(x)
    den = x * x * math.sin(x)
    print(f'  x={x}: {num / den:.4g}')
