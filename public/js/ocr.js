/* 浏览器端 OCR：没有视觉模型时，把图片转成文字再交给 AI。
   tesseract.js 与中英文语言包全部放在 vendor/tesseract 下，离线可用，不依赖外网 CDN
   （国内 jsDelivr 常被墙，走 CDN 等于这个功能对大多数用户不可用）。 */
(function () {
  'use strict';

  const BASE = 'vendor/tesseract/';
  const VISION_MODEL = /gpt-4o|gpt-4\.1|o3|o4|claude|gemini|qwen.*vl|glm-4v|vision|llava|internvl/i;
  let loading = null;

  /* 以 ocr.js 自身的地址推站点根，再拼 vendor 目录，兼容 file:// 与 Pages 子路径 */
  function scriptBase() {
    const s = document.querySelector('script[src*="ocr.js"]');
    if (s) {
      const src = s.getAttribute('src') || '';
      // ocr.js 在 <root>/js/ 下，vendor 在 <root>/vendor/ 下，所以先退掉 js/ 这一层
      const jsDir = src.replace(/[^/]*$/, '');            // './js/' 或 '/repo/js/'
      const root = jsDir.replace(/js\/$/, '');            // './' 或 '/repo/'
      return root + BASE;
    }
    return BASE;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = function () { reject(new Error('OCR 组件加载失败')); };
      document.head.appendChild(el);
    });
  }

  async function ensure() {
    if (window.Tesseract) return window.Tesseract;
    if (!loading) loading = loadScript(scriptBase() + 'tesseract.min.js');
    try { await loading; } catch (e) { loading = null; throw e; }
    if (!window.Tesseract) throw new Error('OCR 组件不可用');
    return window.Tesseract;
  }

  /* dataUrl -> 识别文字。默认中英混合（题目里的中文说明 + 拉丁字母/数字）
     先预处理（放大 + Otsu 二值化）再识别，这是准确率的第一道保障。 */
  async function imageToText(dataUrl, onProgress, langs) {
    const T = await ensure();
    const base = scriptBase();
    let src = dataUrl;
    try { src = await preprocess(dataUrl, { scale: 2 }); } catch (e) { /* 预处理失败用原图 */ }
    const worker = await T.createWorker(langs || 'chi_sim+eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base,              // 同目录有 tesseract-core-simd-lstm.wasm.js
      langPath: base + 'lang',     // lang/chi_sim.traineddata.gz 与 eng.traineddata.gz
      gzip: true,
      logger: function (m) {
        if (m && m.status === 'recognizing text' && onProgress) onProgress(Math.round((m.progress || 0) * 100));
      }
    });
    try {
      const r = await worker.recognize(src);
      return String((r && r.data && r.data.text) || '').trim();
    } finally {
      try { await worker.terminate(); } catch (e) {}
    }
  }

  /* 用户是否配置了能看图的模型 */
  function hasVisionModel() {
    let cfg = null;
    try { cfg = JSON.parse(localStorage.getItem('mv_llm_v1') || 'null'); } catch (e) {}
    if (!cfg || !cfg.apiKey) return false;
    return VISION_MODEL.test(cfg.model || '');
  }

  /* ---------------------------------------------------------------- 预处理
     ProcessOn 那类工具准确率高，一半功劳在预处理：先放大、灰度、拉对比、二值化，
     让字符边缘锐利。tesseract 对模糊小图几乎无解，对清晰黑白图能用得多。 */
  function preprocess(dataUrl, opts) {
    const o = Object.assign({ scale: 2, threshold: 0, invert: false }, opts || {});
    return new Promise(function (resolve) {
      const img = new Image();
      img.onload = function () {
        const w = Math.max(1, Math.round(img.width * o.scale));
        const h = Math.max(1, Math.round(img.height * o.scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const g = cv.getContext('2d');
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, w, h);

        const data = g.getImageData(0, 0, w, h);
        const px = data.data;
        // 灰度 + 统计直方图求自适应阈值
        const hist = new Uint32Array(256);
        for (let i = 0; i < px.length; i += 4) {
          const v = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
          px[i] = px[i + 1] = px[i + 2] = v;
          hist[v]++;
        }
        let th = o.threshold;
        if (!th) {
          // Otsu：让前景/背景类间方差最大，比固定 128 稳
          const total = w * h;
          let sum = 0;
          for (let i = 0; i < 256; i++) sum += i * hist[i];
          let sumB = 0, wB = 0, best = 0;
          for (let i = 0; i < 256; i++) {
            wB += hist[i];
            if (!wB) continue;
            const wF = total - wB;
            if (!wF) break;
            sumB += i * hist[i];
            const mB = sumB / wB, mF = (sum - sumB) / wF;
            const between = wB * wF * (mB - mF) * (mB - mF);
            if (between > best) { best = between; th = i; }
          }
          th = th || 128;
        }
        for (let i = 0; i < px.length; i += 4) {
          let v = px[i] > th ? 255 : 0;
          if (o.invert) v = 255 - v;
          px[i] = px[i + 1] = px[i + 2] = v;
          px[i + 3] = 255;
        }
        g.putImageData(data, 0, 0);
        resolve(cv.toDataURL('image/png'));
      };
      img.onerror = function () { resolve(dataUrl); };
      img.src = dataUrl;
    });
  }

  /* ---------------------------------------------------- 数学符号纠错（规则）
     tesseract 的典型误识别，专门为数学文本写一份替换表。
     注意顺序：先修长模式，避免 `rn`→`m` 把 `\r\n` 类内容搞坏。 */
  const FIXES = [
    [/\bln\s*(\d)/g, 'ln $1'],
    [/(?<![\\a-zA-Z])rn(?![a-zA-Z])/g, 'm'],
    [/(?<![\\a-zA-Z])I\s*n(?![a-zA-Z])/g, 'ln'],
    [/(?<![\\a-zA-Z])s\s*i\s*n\b/g, 'sin'],
    [/(?<![\\a-zA-Z])c\s*o\s*s\b/g, 'cos'],
    [/(?<![\\a-zA-Z])t\s*a\s*n\b/g, 'tan'],
    [/(?<![\\a-zA-Z])l\s*i\s*m\b/g, 'lim'],
    [/(?<![\\a-zA-Z])l\s*n\b/g, 'ln'],
    [/→/g, '\\to '],
    [/≤/g, '\\le '], [/≥/g, '\\ge '], [/≠/g, '\\ne '],
    [/∞/g, '\\infty '], [/π/g, '\\pi '], [/θ/g, '\\theta '],
    [/α/g, '\\alpha '], [/β/g, '\\beta '], [/λ/g, '\\lambda '],
    [/∑/g, '\\sum '], [/∫/g, '\\int '], [/√/g, '\\sqrt '],
    [/×/g, '\\times '], [/÷/g, '\\div '], [/±/g, '\\pm '],
    [/\s*·\s*/g, '\\cdot '],
    [/\bdx\b/g, 'dx'], [/\bd\s*x\b/g, 'dx'],
    [/(\d)\s*([a-zA-Z])\s*\^/g, '$1$2^'],
    [/\^\s*\{?\s*(\d+)\s*\}?/g, '^{$1}']
  ];

  function fixMathText(text) {
    let s = String(text || '');
    for (const [re, rep] of FIXES) s = s.replace(re, rep);
    return s;
  }

  /* 清理 OCR 噪声，保留公式与运算符 */
  function tidy(text) {
    return fixMathText(String(text || ''))
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/(^|\n)\s*[|｜]\s*/g, '$1')
      .trim();
  }

  /* -------------------------------------------- 交给 AI 规范化成真正的 LaTeX
     这是准确率的关键一步：OCR 只负责「认出字形」，由 AI 结合上下文把
     识别串改写成合法 LaTeX（补 \frac、配对花括号、修正上下标归属）。 */
  async function polishWithAI(rawText, opts) {
    const o = opts || {};
    const res = await fetch('api/ai/ocr-fix', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, (window.API && window.API.authHeaders) ? window.API.authHeaders() : {}),
      cache: 'no-store',
      body: JSON.stringify({ text: rawText, problem: o.problem || '', llm: o.llm || null })
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'AI 规范化失败');
    return j.text || rawText;
  }

  window.OCR = {
    imageToText: imageToText,
    hasVisionModel: hasVisionModel,
    preprocess: preprocess,
    tidy: tidy,
    fixMathText: fixMathText,
    polishWithAI: polishWithAI
  };
})();
