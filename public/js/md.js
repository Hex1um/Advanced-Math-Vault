/* 轻量 Markdown + LaTeX 渲染（先抽公式与代码，避免 Markdown 破坏公式）
 *
 * 安全约定：
 *   - 链接/图片的 URL 一律过 sanitizeUrl()，只放行 http(s)/mailto/站内相对路径/锚点，
 *     图片额外放行 data:image/*;base64。javascript:、vbscript:、data:text/html 等
 *     一律降级成纯文本，避免用户内容里的链接变成脚本执行入口。
 *   - 占位符使用每次调用随机生成的 nonce，原文即使含 \u0000 也不会撞上占位符。
 */
(function () {
  'use strict';

  const CTRL = /[\u0000-\u001F\u007F]/g;

  /* 全站唯一的 HTML 转义实现（原本 mathkey.js / phys-constants.js 各抄了一份，
     字符集还不一致 —— 只转 & < > " 的那份用在单引号属性里会漏）。
     现在两处都委托到这里，见各自文件里的 escapeHtml。 */
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* 反解 esc() 造成的实体，只为判断协议；渲染时仍走 esc/safe 后的值 */
  function unescEntities(s) {
    return String(s)
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  /**
   * URL 白名单。返回安全 URL，或 null（调用方降级成纯文本）。
   * @param {string} raw
   * @param {{allowDataImage?: boolean}} [opts]
   */
  function sanitizeUrl(raw, opts) {
    const o = opts || {};
    let url = unescEntities(raw == null ? '' : raw);
    // 制表符/换行/空格常被用来把 javascript: 拆成 java\tscript: 绕过前缀检查
    url = url.replace(/[\u0000-\u0020]/g, '').trim();
    if (!url) return null;
    const lower = url.toLowerCase();
    if (/^https?:\/\//.test(lower)) return url;
    if (/^mailto:/.test(lower)) return url;
    if (url[0] === '#' || url[0] === '/') return url;
    if (/^\.\.?\//.test(url)) return url;
    if (o.allowDataImage && /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(url)) return url;
    return null;
  }

  function cleanBody(body) {
    let b = String(body || '');
    b = b.trim();
    b = b.replace(/^\\\[|\\\]$/g, '').replace(/^\\\(|\\\)$/g, '');
    b = b.replace(/^\$\$|\$\$$/g, '');
    return b.trim();
  }

  /* 占位符：\u0000<nonce>T<idx>\u0000，nonce 每次调用随机，避免与原文碰撞 */
  function makeNonce() {
    return 'n' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  /**
   * 按「围栏代码 → 行内代码 → 数学公式」的顺序抽成占位符。
   * 顺序不能反：先抽代码，代码里的 $ 才不会被当成公式边界。
   */
  function protect(src) {
    const nonce = makeNonce();
    const tokens = [];
    const put = (kind, payload) => {
      tokens.push(Object.assign({ kind: kind }, payload));
      return '\u0000' + nonce + 'T' + (tokens.length - 1) + '\u0000';
    };

    let out = String(src == null ? '' : src);

    // ① 围栏代码块 ```lang ... ```
    out = out.replace(/```([\w+-]*)\r?\n?([\s\S]*?)```/g, function (m, lang, code) {
      return put('fence', { body: code.replace(/\n$/, ''), lang: lang || '' });
    });

    // ② 行内代码（1~3 个反引号，不跨行）
    out = out.replace(/(`{1,3})([^`\n]+?)\1/g, function (m, ticks, code) {
      return put('code', { body: code });
    });

    // ③ 数学公式：$$...$$ / \[...\] / \(...\) / $...$（忽略转义 \$）
    out = out.replace(/\$\$([\s\S]+?)\$\$/g, function (m, body) {
      return put('math', { body: cleanBody(body), display: true });
    });
    out = out.replace(/\\\[([\s\S]+?)\\\]/g, function (m, body) {
      return put('math', { body: cleanBody(body), display: true });
    });
    out = out.replace(/\\\(([\s\S]+?)\\\)/g, function (m, body) {
      return put('math', { body: cleanBody(body), display: false });
    });
    out = out.replace(/(^|[^\\$])\$([^\n$]+?)\$/g, function (m, pre, body) {
      return pre + put('math', { body: cleanBody(body), display: false });
    });

    return { text: out, tokens: tokens, nonce: nonce };
  }

  function restoreOne(tk) {
    if (!tk) return '';
    if (tk.kind === 'fence') {
      const cls = tk.lang ? ' class="language-' + esc(tk.lang) + '"' : '';
      return '<pre><code' + cls + '>' + esc(tk.body) + '</code></pre>';
    }
    if (tk.kind === 'code') return '<code>' + esc(tk.body) + '</code>';
    if (tk.kind === 'math') {
      const body = esc(tk.body);
      return tk.display ? '$$' + body + '$$' : '$' + body + '$';
    }
    return '';
  }

  function restoreAll(html, pkg) {
    const re = new RegExp('\\u0000' + pkg.nonce + 'T(\\d+)\\u0000', 'g');
    return String(html).replace(re, function (m, idx) {
      return restoreOne(pkg.tokens[Number(idx)]);
    });
  }

  function inline(s) {
    let t = esc(s);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // 图片先于链接匹配（![alt](url) 里也含 [alt](url)）
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (m, alt, url) {
      const safe = sanitizeUrl(url, { allowDataImage: true });
      if (!safe) return alt; // 不安全地址只留 alt 文本，不产出可点击/可加载元素
      return '<img src="' + esc(safe) + '" alt="' + esc(alt) + '" loading="lazy" referrerpolicy="no-referrer" />';
    });
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (m, text, url) {
      const safe = sanitizeUrl(url);
      if (!safe) return text;
      const external = /^https?:\/\//i.test(safe);
      return '<a href="' + esc(safe) + '"'
        + (external ? ' target="_blank"' : '')
        + ' rel="noopener noreferrer nofollow">' + text + '</a>';
    });
    return t;
  }

  function toHtml(src) {
    const pkg = protect(src);
    const lines = pkg.text.split(/\r?\n/);
    const standalone = new RegExp('^\\u0000' + pkg.nonce + 'T(\\d+)\\u0000$');
    const html = [];
    let para = [];
    let listType = null;

    function flushPara() {
      if (para.length) {
        html.push('<p>' + inline(para.join(' ')) + '</p>');
        para = [];
      }
    }
    function closeList() {
      if (listType) { html.push('</' + listType + '>'); listType = null; }
    }
    function openList(type) {
      if (listType === type) return;
      closeList();
      listType = type;
      html.push('<' + type + '>');
    }

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.replace(/\s+$/, '');

      if (!line.trim()) { flushPara(); closeList(); continue; }

      // 独占一行的公式 / 围栏代码：块级输出，别塞进 <p>
      const tok = line.trim().match(standalone);
      if (tok) {
        const tk = pkg.tokens[Number(tok[1])];
        if (tk && tk.kind !== 'code') {
          flushPara(); closeList();
          html.push(tk.kind === 'math' && tk.display
            ? '<div class="math-block">' + restoreOne(tk) + '</div>'
            : restoreOne(tk));
          continue;
        }
      }

      let m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        flushPara(); closeList();
        const lv = Math.min(4, m[1].length);
        html.push('<h' + lv + '>' + inline(m[2]) + '</h' + lv + '>');
        continue;
      }

      if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
        flushPara(); closeList(); html.push('<hr/>'); continue;
      }

      if (/^\s*>\s?/.test(line)) {
        flushPara(); closeList();
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        i--;
        html.push('<blockquote>' + inline(buf.join(' ')) + '</blockquote>');
        continue;
      }

      m = line.match(/^\s*[-*+]\s+(.*)$/);
      if (m) {
        flushPara(); openList('ul');
        html.push('<li>' + inline(m[1]) + '</li>');
        continue;
      }

      m = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (m) {
        flushPara(); openList('ol');
        html.push('<li>' + inline(m[1]) + '</li>');
        continue;
      }

      para.push(line.trim());
    }
    flushPara(); closeList();

    return restoreAll(html.join('\n'), pkg);
  }

  let katexWarned = false;

  function renderMath(root) {
    if (!root) return;
    if (typeof window === 'undefined' || typeof window.renderMathInElement !== 'function') {
      if (!katexWarned) {
        katexWarned = true;
        console.warn('[md] KaTeX 未加载，公式以源码显示');
      }
      return;
    }
    try {
      window.renderMathInElement(root, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false }
        ],
        throwOnError: false,
        errorColor: '#ff9b9b',
        strict: false,
        macros: {
          '\\arccot': '\\operatorname{arccot}',
          '\\arcsec': '\\operatorname{arcsec}',
          '\\arccsc': '\\operatorname{arccsc}',
          '\\sech': '\\operatorname{sech}',
          '\\csch': '\\operatorname{csch}',
          '\\sgn': '\\operatorname{sgn}',
          '\\arctg': '\\arctan',
          '\\arcctg': '\\operatorname{arccot}',
          '\\tg': '\\tan',
          '\\ctg': '\\cot'
        },
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
      });
    } catch (e) {
      console.warn('[md] 公式渲染失败', e);
    }
  }

  function render(el, src) {
    if (!el) return;
    el.innerHTML = toHtml(src);
    renderMath(el);
  }

  /* 行内渲染：必须先抽代码与公式，再跑 Markdown 行内替换，
     否则 $a_1 * b_2$ 里的 _ 和 * 会被当成强调标记。 */
  function inlineTex(src) {
    const pkg = protect(src);
    const html = restoreAll(inline(pkg.text), pkg);
    if (typeof document === 'undefined') return html;
    const d = document.createElement('span');
    d.innerHTML = html;
    renderMath(d);
    return d.innerHTML;
  }

  /* ------------------------------------------------------------ 配图
   * 题库里的配图只允许「仓库内相对路径 + 白名单目录」，并且**不做 SVG 内联**：
   * 直接把题库里的 <svg> 字符串塞进 innerHTML 等于把 XSS 开关交给投稿人，
   * <script>、onload、<foreignObject> 三种路子都能执行脚本。这里统一走
   * <img src>：浏览器只在图片上下文里解析它，脚本不会执行；
   * 门禁（tools/import/gate.mjs）在入库时再扫一遍 SVG 源码，双保险。 */
  const DIAGRAM_WHITELIST = [
    /^assets\/diagrams\/physics\/[\w./-]+\.(svg|webp|png|jpg)$/i,
    /^assets\/diagrams\/[\w./-]+\.(webp|png|jpg)$/i
  ];

  function diagramUrl(src) {
    const s = String(src || '').trim();
    if (!s || s.indexOf('..') >= 0) return '';
    if (!DIAGRAM_WHITELIST.some(function (re) { return re.test(s); })) return '';
    return './' + s.replace(/^\.?\//, '');
  }

  let lightboxBound = false;
  function bindLightbox() {
    if (lightboxBound || typeof document === 'undefined') return;
    lightboxBound = true;
    document.addEventListener('click', function (ev) {
      const img = ev.target.closest && ev.target.closest('img.diagram-img');
      if (!img) return;
      ev.preventDefault();
      let box = document.getElementById('diagramLightbox');
      if (!box) {
        box = document.createElement('div');
        box.id = 'diagramLightbox';
        box.className = 'diagram-lightbox';
        box.innerHTML = '<img alt="" /><button class="diagram-close" aria-label="关闭">×</button>';
        document.body.appendChild(box);
        box.addEventListener('click', function () { box.classList.remove('open'); });
        document.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') box.classList.remove('open');
        });
      }
      const big = box.querySelector('img');
      big.src = img.getAttribute('src');
      big.alt = img.getAttribute('alt') || '';
      box.classList.add('open');
    });
  }

  /**
   * 渲染配图列表（placement = statement | solution）。
   * @param {Array} diagrams
   * @param {string} placement
   * @returns {string} HTML
   */
  function diagramHtml(diagrams, placement) {
    const list = (diagrams || []).filter(function (d) {
      return d && (!d.placement || d.placement === (placement || 'statement'));
    });
    if (!list.length) return '';
    bindLightbox();
    return '<div class="diagram-grid">' + list.map(function (d) {
      const url = diagramUrl(d.src);
      if (!url) {
        return '<div class="diagram-broken">配图路径不在白名单内：' + esc(String(d.src || '')) + '</div>';
      }
      return '<figure class="diagram"><img class="diagram-img" src="' + esc(url) + '" alt="'
        + esc(d.alt || '题目配图') + '" loading="lazy" /><figcaption>' + esc(d.alt || '点击放大') + '</figcaption></figure>';
    }).join('') + '</div>';
  }

  const Md = {
    render: render,
    toHtml: toHtml,
    renderMath: renderMath,
    esc: esc,
    inlineTex: inlineTex,
    inline: inline,
    sanitizeUrl: sanitizeUrl,
    diagramUrl: diagramUrl,
    diagramHtml: diagramHtml
  };

  if (typeof window !== 'undefined') window.Md = Md;
  if (typeof module !== 'undefined' && module.exports) module.exports = Md;
})();
