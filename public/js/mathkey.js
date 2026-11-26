/* 数学公式键盘（GeoGebra 风格）
   挂在任意 textarea 下面，点按钮把 LaTeX 片段插到光标处。
   - 光标已经在 $...$ 里 → 直接插；否则自动补一对 $...$
   - 插入串里的 $0 表示「插入后光标停这里」
   - 有选中文本时，选中内容会填进 $0 的位置（例如选中 x 再点「根号」→ \sqrt{x}）
   用法：window.MathKey.attach(textareaEl, { open:false })
*/
(function () {
  'use strict';

  const G = {
    n: { t: 'n', v: 'n' },
    x: { t: 'x', v: 'x' },
    y: { t: 'y', v: 'y' },
    z: { t: 'z', v: 'z' },
    a: { t: 'a', v: 'a' },
    b: { t: 'b', v: 'b' }
  };

  function B(t, v, title) { return { t: t, v: v === undefined ? t : v, title: title || '' }; }

  const TABS = [
    {
      name: '常用',
      cols: 8,
      keys: [
        // 左侧按计算器习惯排数字键区，右侧是变量与常用运算
        B('7'), B('8'), B('9'), B('÷', '\\div'), B('('), B(')'), B('x'), B('y'),
        B('4'), B('5'), B('6'), B('×', '\\times'), B('^', '^{$0}'), B('_', '_{$0}'), B('z'), B('a'),
        B('1'), B('2'), B('3'), B('−', '-'), B('√', '\\sqrt{$0}', '平方根'), B('π', '\\pi'), B('b'), B('n'),
        B('0'), B('.'), B(',', ','), B('+'), B('∞', '\\infty'), B('=', '='), B('e'), B('|', '|'),
        B('分数', '\\frac{$0}{}', '分式，选中内容会做分子'),
        B('n次根', '\\sqrt[n]{$0}'),
        B('绝对值', '\\left|$0\\right|'),
        B('括号', '\\left($0\\right)'),
        B('大括号', '\\left\\{$0\\right\\}'),
        B('≤', '\\le'), B('≥', '\\ge'), B('≠', '\\neq'),
        B('·', '\\cdot'), B('±', '\\pm'), B('…', '\\cdots'), B('≈', '\\approx'), B('°', '^{\\circ}'), B('百分', '\\%'), B('floor', '\\lfloor $0 \\rfloor', '向下取整'), B('ceil', '\\lceil $0 \\rceil', '向上取整')
      ]
    },
    {
      name: '符号',
      cols: 8,
      keys: [
        B('α', '\\alpha'), B('β', '\\beta'), B('γ', '\\gamma'), B('δ', '\\delta'), B('θ', '\\theta'), B('λ', '\\lambda'), B('μ', '\\mu'), B('ν', '\\nu'),
        B('σ', '\\sigma'), B('φ', '\\varphi'), B('ω', '\\omega'), B('ρ', '\\rho'), B('τ', '\\tau'), B('Δ', '\\Delta'), B('Σ', '\\Sigma'), B('Ω', '\\Omega'),
        B('∈', '\\in'), B('∉', '\\notin'), B('⊂', '\\subset'), B('⊆', '\\subseteq'), B('∪', '\\cup'), B('∩', '\\cap'), B('∅', '\\varnothing'), B('∀', '\\forall'),
        B('∃', '\\exists'), B('→', '\\to'), B('⇒', '\\Rightarrow'), B('⇔', '\\Leftrightarrow'), B('∵', '\\because'), B('∴', '\\therefore'), B('∝', '\\propto'), B('⊥', '\\perp'),
        B('∥', '\\parallel'), B('∠', '\\angle'), B('△', '\\triangle'), B('°', '^{\\circ}'), B('′', "'"), B('floor', '\\lfloor $0 \\rfloor', '向下取整'), B('ceil', '\\lceil $0 \\rceil', '向上取整'), B('宋体', '\\text{$0}')
      ]
    },
    {
      name: '微积分',
      cols: 8,
      keys: [
        B('d/dx', '\\frac{\\mathrm{d}}{\\mathrm{d}x}'), B('∂', '\\partial'), B('∇', '\\nabla'), B('∫', '\\int'),
        B('∫ᵃᵇ', '\\int_{a}^{b}'), B('∬', '\\iint'), B('∭', '\\iiint'), B('∮', '\\oint'),
        B('lim', '\\lim_{x\\to $0}', '极限，$0 处填趋近值'), B('Σ', '\\sum_{$0}^{}'), B('Π', '\\prod_{$0}^{}'), B('∞', '\\infty'),
        B('sin'), B('cos'), B('tan'), B('cot'),
        B('sec'), B('csc'), B('arcsin', '\\arcsin'), B('arctan', '\\arctan'),
        B('ln'), B('lg'), B('log', '\\log_{$0}'), B('exp', '\\exp'),
        B("f'(x)", "f'(x)"), B("f''(x)", "f''(x)"), B('→0', '\\to 0'), B('→∞', '\\to \\infty')
      ]
    },
    {
      name: '线代',
      cols: 8,
      keys: [
        B('A'), B('B'), B('C'), B('X'), B('T', '^{\\mathrm{T}}', '转置'), B('⁻¹', '^{-1}', '逆'), B('*', '^{*}'), B('⋯', '\\cdots'),
        B('矩阵', '\\begin{pmatrix} $0 & \\\\ & \\end{pmatrix}', '2×2 矩阵'),
        B('行列式', '\\begin{vmatrix} $0 & \\\\ & \\end{vmatrix}'),
        B('向量', '\\vec{$0}'),
        B('det', '\\det'), B('rank', '\\operatorname{rank}'), B('tr', '\\operatorname{tr}'),
        B('diag', '\\operatorname{diag}'), B('转置ᵀ', '^{\\mathrm{T}}'), B('特征λ', '\\lambda'),
        B('⋮', '\\vdots'), B('⋱', '\\ddots'), B('(', '('), B(')', ')'),
        B('横线', '\\overline{$0}'), B('上标', '^{$0}'), B('下标', '_{$0}'), B('→', '\\to')
      ]
    }
  ];

  /* 物理专用分组：只在 subject=physics 时追加到键盘末尾。
     矢量箭头、偏导、梯度、单位容器与常用常数是物理解题最高频的输入，
     数学键盘里的「线代」「微积分」分组不够用（没有 \vec、\hat、\mathrm{}）。 */
  const PHYS_TABS = [
    {
      name: '矢量',
      cols: 8,
      keys: [
        B('a⃗', '\\vec{a}'), B('F⃗', '\\vec{F}'), B('v⃗', '\\vec{v}'), B('单位矢', '\\hat{$0}'),
        B('·', '\\cdot', '点乘'), B('×', '\\times', '叉乘'), B('|a|', '\\left|$0\\right|'),
        B('分量', '($0_x,\\ $0_y,\\ $0_z)'),
        B('∂', '\\frac{\\partial $0}{\\partial }', '偏导'), B('∇', '\\nabla'), B('∇·', '\\nabla\\cdot', '散度'),
        B('∇×', '\\nabla\\times', '旋度'), B('Δ', '\\Delta'), B('∮', '\\oint', '环路积分'),
        B('∫', '\\int'), B('∬', '\\iint'), B('d', '\\mathrm{d}'),
        B('→', '\\to'), B('⇒', '\\Rightarrow'), B('∝', '\\propto'), B('≈', '\\approx'), B('≡', '\\equiv'),
        B('∥', '\\parallel'), B('⊥', '\\perp'), B('θ', '\\theta'), B('φ', '\\varphi'), B('ω', '\\omega')
      ]
    },
    {
      name: '物理量',
      cols: 8,
      keys: [
        B('单位', '\\ \\mathrm{$0}'), B('m/s', '\\ \\mathrm{m/s}'), B('m/s²', '\\ \\mathrm{m/s^2}'),
        B('N', '\\ \\mathrm{N}'), B('J', '\\ \\mathrm{J}'), B('W', '\\ \\mathrm{W}'), B('Pa', '\\ \\mathrm{Pa}'), B('V', '\\ \\mathrm{V}'),
        B('A', '\\ \\mathrm{A}'), B('C', '\\ \\mathrm{C}'), B('Ω', '\\ \\Omega'), B('F', '\\ \\mathrm{F}'),
        B('H', '\\ \\mathrm{H}'), B('T', '\\ \\mathrm{T}'), B('eV', '\\ \\mathrm{eV}'), B('K', '\\ \\mathrm{K}'),
        B('g', 'g'), B('G', 'G'), B('c', 'c'), B('e', 'e'), B('h', 'h'), B('k_B', 'k_B'), B('N_A', 'N_A'),
        B('ε₀', '\\varepsilon_0'), B('μ₀', '\\mu_0'), B('ℏ', '\\hbar'), B('λ', '\\lambda'), B('ρ', '\\rho'), B('μ', '\\mu')
      ]
    }
  ];

  /* 专业物理 / 天文分组：四大力学与天体物理的高频符号。
     这些符号在普物键盘里没有（Dirac 括号、算符、度规、太阳量），
     手打一次 \langle \psi | \hat{H} | \psi \rangle 要十几秒。 */
  const PHYS_ADV_TABS = [
    {
      name: '分析力学',
      cols: 8,
      keys: [
        B('L', '\\mathcal{L}'), B('H', '\\mathcal{H}'), B('T', 'T'), B('V', 'V'),
        B('q̇', '\\dot{q}'), B('q̈', '\\ddot{q}'), B('∂L/∂q', '\\frac{\\partial L}{\\partial q}'),
        B('d/dt', '\\frac{\\mathrm{d}}{\\mathrm{d}t}'),
        B('δ', '\\delta'), B('δS', '\\delta S=0', '最小作用量原理'),
        B('{q,p}', '\\{q,p\\}', 'Poisson 括号'),
        B('ω', '\\omega'), B('Γ', '\\Gamma'), B('θ', '\\theta'), B('φ', '\\varphi'),
        B('˙', '\\dot{$0}'), B('¨', '\\ddot{$0}'), B('Σ', '\\sum'), B('∫', '\\int'),
        B('⇒', '\\Rightarrow'), B('≈', '\\approx'), B('→', '\\to'), B('≡', '\\equiv'),
        B('△', '\\triangle'), B('∮', '\\oint'), B('⋆', '\\star'), B('∗', '^{*}')
      ]
    },
    {
      name: '量子算符',
      cols: 8,
      keys: [
        B('⟨ψ|', '\\langle \\psi |'), B('|ψ⟩', '| \\psi \\rangle'),
        B('⟨|⟩', '\\langle $0 \\rangle'),
        B('⟨A⟩', '\\langle A \\rangle'), B('Ĥ', '\\hat{H}'), B('p̂', '\\hat{p}'), B('x̂', '\\hat{x}'),
        B('[A,B]', '\\left[\\hat{A},\\hat{B}\\right]', '对易子'),
        B('{A,B}', '\\left\\{\\hat{A},\\hat{B}\\right\\}', '反对易子'),
        B('†', '^{\\dagger}'), B('ψ', '\\psi'), B('ϕ', '\\phi'), B('ℓ', '\\ell'), B('m', 'm'),
        B('Y_l^m', 'Y_{$0}^{m}'), B('|n⟩', '| n \\rangle'),
        B('δ_ij', '\\delta_{ij}'), B('ε_ijk', '\\varepsilon_{ijk}'),
        B('ℏ', '\\hbar'), B('∇²', '\\nabla^2'), B('Σ', '\\sum'), B('√', '\\sqrt{$0}'),
        B('∂', '\\partial'), B('≈', '\\approx'), B('∝', '\\propto'), B('±', '\\pm')
      ]
    },
    {
      name: '相对论',
      cols: 8,
      keys: [
        B('g_μν', 'g_{\\mu\\nu}'), B('F^μν', 'F^{\\mu\\nu}'), B('∂_μ', '\\partial_{\\mu}'),
        B('x^μ', 'x^{\\mu}'), B('Λ', '\\Lambda'), B('γ', '\\gamma'), B('β', '\\beta'),
        B('u^μ', 'u^{\\mu}'), B('T^μν', 'T^{\\mu\\nu}'), B('A^μ', 'A^{\\mu}'),
        B('η_μν', '\\eta_{\\mu\\nu}'), B('ds²', '\\mathrm{d}s^2'), B('Σ', '\\Sigma'),
        B('→', '\\to'), B('≈', '\\approx'), B('≪', '\\ll'), B('≫', '\\gg'),
        B('μ', '\\mu'), B('ν', '\\nu'), B('ρ', '\\rho'), B('α', '\\alpha'),
        B('c', 'c'), B('ℏ', '\\hbar'), B('G', 'G'), B('√', '\\sqrt{$0}')
      ]
    },
    {
      name: '天文',
      cols: 8,
      keys: [
        B('M⊙', 'M_{\\odot}'), B('R⊙', 'R_{\\odot}'), B('L⊙', 'L_{\\odot}'),
        B('AU', '\\ \\mathrm{AU}'), B('pc', '\\ \\mathrm{pc}'), B('Mpc', '\\ \\mathrm{Mpc}'),
        B('erg', '\\ \\mathrm{erg}'), B('Å', '\\ \\mathrm{\\AA}'), B('Jy', '\\ \\mathrm{Jy}'),
        B('mag', '\\ \\mathrm{mag}'), B('yr', '\\ \\mathrm{yr}'), B('Gyr', '\\ \\mathrm{Gyr}'),
        B('α', '\\alpha'), B('δ', '\\delta'), B('λ', '\\lambda'), B('ν', '\\nu'),
        B('z', 'z'), B('H₀', 'H_0'), B('Ω', '\\Omega'), B('Λ', '\\Lambda'),
        B('T_eff', 'T_{\\mathrm{eff}}'), B('log g', '\\log g'), B('⊕', '\\oplus'), B('⊙', '\\odot')
      ]
    }
  ];

  function tabsFor(subject) {
    return String(subject || '') === 'physics' ? TABS.concat(PHYS_TABS, PHYS_ADV_TABS) : TABS;
  }

  /* --------------------------------------------------------- 公式环境状态机
     旧实现只数「非转义 $ 的奇偶」，遇到 $$...$$（两个 $ 奇偶不变）、\[...\]、
     \(...\)、代码块都会判错，插入符号时就多包或少包一对 $。
     现在做单遍词法扫描，返回光标所在的精确环境。 */
  function scanContext(value, pos) {
    const s = String(value == null ? '' : value);
    const n = Math.max(0, Math.min(pos == null ? s.length : pos, s.length));
    let mode = 'TEXT';
    let i = 0;
    while (i < n) {
      const ch = s[i];
      if (mode === 'TEXT') {
        if (ch === '\\') {
          if (s[i + 1] === '[') { mode = 'BRACKET_BLOCK'; i += 2; continue; }
          if (s[i + 1] === '(') { mode = 'PAREN_INLINE'; i += 2; continue; }
          i += 2; // \$ \\ 等转义，跳过被转义的字符
          continue;
        }
        if (ch === '`') {
          const lineStart = s.lastIndexOf('\n', i - 1) + 1;
          const before = s.slice(lineStart, i);
          if (/^\s*$/.test(before) && s.slice(i, i + 3) === '```') { mode = 'FENCE_CODE'; i += 3; continue; }
          mode = 'INLINE_CODE'; i += 1; continue;
        }
        if (ch === '$') {
          if (s[i + 1] === '$') { mode = 'DOLLAR_BLOCK'; i += 2; continue; }
          mode = 'DOLLAR_INLINE'; i += 1; continue;
        }
        i += 1;
        continue;
      }
      if (mode === 'INLINE_CODE') {
        if (ch === '`') { mode = 'TEXT'; }
        i += 1;
        continue;
      }
      if (mode === 'FENCE_CODE') {
        if (s.slice(i, i + 3) === '```') { mode = 'TEXT'; i += 3; continue; }
        i += 1;
        continue;
      }
      if (mode === 'DOLLAR_INLINE') {
        if (ch === '\\') { i += 2; continue; }
        if (ch === '$') { mode = 'TEXT'; }
        i += 1;
        continue;
      }
      if (mode === 'DOLLAR_BLOCK') {
        if (ch === '\\') { i += 2; continue; }
        if (s.slice(i, i + 2) === '$$') { mode = 'TEXT'; i += 2; continue; }
        i += 1;
        continue;
      }
      if (mode === 'PAREN_INLINE') {
        if (ch === '\\' && s[i + 1] === ')') { mode = 'TEXT'; i += 2; continue; }
        i += 1;
        continue;
      }
      if (mode === 'BRACKET_BLOCK') {
        if (ch === '\\' && s[i + 1] === ']') { mode = 'TEXT'; i += 2; continue; }
        i += 1;
        continue;
      }
      i += 1;
    }
    const inMath = mode === 'DOLLAR_INLINE' || mode === 'DOLLAR_BLOCK' || mode === 'PAREN_INLINE' || mode === 'BRACKET_BLOCK';
    return { inMath: inMath, mode: mode, inCode: mode === 'INLINE_CODE' || mode === 'FENCE_CODE' };
  }

  function insideMath(value, pos) {
    return scanContext(value, pos).inMath;
  }

  function insert(ta, tpl) {
    const value = ta.value;
    let start = ta.selectionStart == null ? value.length : ta.selectionStart;
    let end = ta.selectionEnd == null ? start : ta.selectionEnd;
    const sel = value.slice(start, end);

    let text = tpl;
    let caret = -1;
    if (text.indexOf('$0') >= 0) {
      caret = text.indexOf('$0');
      text = text.replace('$0', sel || '');
    }

    const ctx = scanContext(value, start);
    // 代码块/行内代码里插入的是代码，不补 $ 包裹；已在公式环境里也不再包一层
    const needWrap = !ctx.inMath && !ctx.inCode;
    const wrapped = needWrap && text !== '' ? '$' + text + '$' : text;
    const shift = needWrap && text !== '' ? 1 : 0;

    const before = value.slice(0, start);
    const after = value.slice(end);
    ta.value = before + wrapped + after;

    const pos = caret >= 0
      ? start + shift + caret + (sel ? sel.length : 0)
      : start + wrapped.length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function build(ta, opts) {
    const TABS = tabsFor(opts && opts.subject);
    const wrap = document.createElement('div');
    wrap.className = 'mk';

    const bar = document.createElement('div');
    bar.className = 'mk-bar';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mk-toggle';
    toggle.innerHTML = '<span>∑</span> 公式键盘';
    bar.appendChild(toggle);

    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'mk-toggle';
    previewBtn.innerHTML = '预览';
    previewBtn.title = '用 KaTeX 渲染当前输入的内容';
    bar.appendChild(previewBtn);

    wrap.appendChild(bar);

    const panel = document.createElement('div');
    panel.className = 'mk-panel';
    panel.style.display = opts && opts.open ? 'block' : 'none';

    const tabs = document.createElement('div');
    tabs.className = 'mk-tabs';
    const grid = document.createElement('div');
    grid.className = 'mk-grid';
    panel.appendChild(tabs);
    panel.appendChild(grid);
    wrap.appendChild(panel);

    /* 预览区：放在输入框上方，写公式时抬眼就能看到渲染结果 */
    const preview = document.createElement('div');
    preview.className = 'mk-preview md';
    preview.style.display = 'none';
    ta.parentNode.insertBefore(preview, ta);

    let previewOpen = false;
    let timer = null;

    function paintPreview() {
      if (!previewOpen) return;
      const text = ta.value;
      if (!text.trim()) {
        preview.innerHTML = '<span class="muted small">（输入内容后这里会显示渲染效果）</span>';
        return;
      }
      if (window.Md && window.Md.render) window.Md.render(preview, text);
      else preview.textContent = text;
    }

    function schedulePreview() {
      if (!previewOpen) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(paintPreview, 220);
    }

    ta.addEventListener('input', schedulePreview);
    ta.addEventListener('change', schedulePreview);

    previewBtn.addEventListener('click', function () {
      previewOpen = !previewOpen;
      preview.style.display = previewOpen ? 'block' : 'none';
      previewBtn.classList.toggle('on', previewOpen);
      if (previewOpen) { paintPreview(); preview.scrollIntoView({ block: 'nearest' }); }
    });

    function renderTab(i) {
      TABS.forEach(function (t, k) {
        const b = tabs.children[k];
        if (b) b.classList.toggle('on', k === i);
      });
      const tab = TABS[i];
      grid.style.gridTemplateColumns = 'repeat(' + tab.cols + ', minmax(0, 1fr))';
      grid.innerHTML = tab.keys.map(function (key, idx) {
        return '<button type="button" class="mk-key" data-i="' + idx + '"' + (key.title ? ' title="' + key.title + '"' : '') + '>'
          + escapeHtml(key.t) + '</button>';
      }).join('');
      Array.prototype.forEach.call(grid.querySelectorAll('.mk-key'), function (btn) {
        btn.addEventListener('mousedown', function (e) { e.preventDefault(); }); // 别抢走光标
        btn.addEventListener('click', function () {
          insert(ta, tab.keys[Number(btn.getAttribute('data-i'))].v);
        });
      });
    }

    TABS.forEach(function (t, k) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mk-tab' + (k === 0 ? ' on' : '');
      b.textContent = t.name;
      b.addEventListener('click', function () { renderTab(k); });
      tabs.appendChild(b);
    });
    renderTab(0);

    toggle.addEventListener('click', function () {
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
      toggle.classList.toggle('on', !open);
      if (!open) ta.focus();
    });

    // 插在 textarea 后面（如果外面包了 .field，就放到 .field 里）
    ta.parentNode.insertBefore(wrap, ta.nextSibling);
    return { el: wrap, insert: function (tpl) { insert(ta, tpl); } };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  const cache = new WeakMap();

  const MathKeyAPI = {
    attach: function (ta, opts) {
      if (!ta) return null;
      if (cache.has(ta)) return cache.get(ta);
      const inst = build(ta, opts || {});
      cache.set(ta, inst);
      return inst;
    },
    // 给对话框里的多个输入框一次性挂上
    attachAll: function (root, opts) {
      if (!root) return;
      const o = opts || {};
      Array.prototype.forEach.call(root.querySelectorAll('textarea'), function (ta) {
        if (ta.readOnly || ta.disabled) return;
        if (ta.getAttribute('data-nomk') === '1') return;
        MathKeyAPI.attach(ta, o);
      });
    },
    insert: function (ta, tpl) {
      const inst = MathKeyAPI.attach(ta);
      if (inst) inst.insert(tpl);
    },
    // 纯函数：给单测与预览用的公式环境判定
    context: scanContext,
    insideMath: insideMath
  };

  if (typeof window !== 'undefined') window.MathKey = MathKeyAPI;
  if (typeof module !== 'undefined' && module.exports) module.exports = MathKeyAPI;
})();
