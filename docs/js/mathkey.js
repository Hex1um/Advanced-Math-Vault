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

  /* 光标是否已经在 $...$ 里 */
  function insideMath(value, pos) {
    let dollars = 0;
    for (let i = 0; i < pos; i++) {
      if (value[i] === '\\') { i++; continue; }
      if (value[i] === '$') dollars++;
    }
    return dollars % 2 === 1;
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

    const needWrap = !insideMath(value, start);
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

  window.MathKey = {
    attach: function (ta, opts) {
      if (!ta) return null;
      if (cache.has(ta)) return cache.get(ta);
      const inst = build(ta, opts || {});
      cache.set(ta, inst);
      return inst;
    },
    // 给对话框里的多个输入框一次性挂上
    attachAll: function (root) {
      if (!root) return;
      Array.prototype.forEach.call(root.querySelectorAll('textarea'), function (ta) {
        if (ta.readOnly || ta.disabled) return;
        if (ta.getAttribute('data-nomk') === '1') return;
        window.MathKey.attach(ta);
      });
    },
    insert: function (ta, tpl) {
      const inst = window.MathKey.attach(ta);
      if (inst) inst.insert(tpl);
    }
  };
})();
