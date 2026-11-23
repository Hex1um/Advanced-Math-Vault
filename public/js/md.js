/* 轻量 Markdown + LaTeX 渲染（先抽公式，避免 Markdown 破坏公式） */
(function () {
  'use strict';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function extract(src) {
    const math = [];
    const codes = [];
    let out = String(src == null ? '' : src);

    out = out.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, function (m, lang, code) {
      codes.push(code.replace(/\n$/, ''));
      return '\u0000C' + (codes.length - 1) + '\u0000';
    });

    out = out.replace(/\$\$([\s\S]+?)\$\$/g, function (m, body) {
      math.push({ display: true, body: body });
      return '\u0000M' + (math.length - 1) + '\u0000';
    });

    out = out.replace(/\\\[([\s\S]+?)\\\]/g, function (m, body) {
      math.push({ display: true, body: body });
      return '\u0000M' + (math.length - 1) + '\u0000';
    });

    out = out.replace(/(^|[^\\$])\$([^\n$]+?)\$/g, function (m, pre, body) {
      math.push({ display: false, body: body });
      return pre + '\u0000M' + (math.length - 1) + '\u0000';
    });

    return { text: out, math: math, codes: codes };
  }

  function inline(s) {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, function (m, c) { return '<code>' + c + '</code>'; });
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return t;
  }

  function toHtml(src) {
    const pkg = extract(src);
    const lines = pkg.text.split(/\r?\n/);
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

      if (/^\u0000M\d+\u0000$/.test(line.trim())) {
        flushPara(); closeList();
        html.push('<div class="math-block">' + line.trim() + '</div>');
        continue;
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

    let out = html.join('\n');

    out = out.replace(/\u0000M(\d+)\u0000/g, function (mm, idx) {
      const item = pkg.math[Number(idx)];
      if (!item) return '';
      const body = esc(item.body);
      if (item.display) return '$$' + body + '$$';
      return '$' + body + '$';
    });

    out = out.replace(/\u0000C(\d+)\u0000/g, function (mm, idx) {
      return '<pre><code>' + esc(pkg.codes[Number(idx)] || '') + '</code></pre>';
    });

    return out;
  }

  let katexWarned = false;

  function renderMath(root) {
    if (!root) return;
    if (typeof window.renderMathInElement !== 'function') {
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

  function inlineTex(src) {
    const d = document.createElement('span');
    d.innerHTML = inline(src);
    renderMath(d);
    return d.innerHTML;
  }

  window.Md = { render: render, toHtml: toHtml, renderMath: renderMath, esc: esc, inlineTex: inlineTex };
})();
