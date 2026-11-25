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

  /* ---------------------------------------------------------------- 采集端质检
     糊、歪、光照不匀是最伤识别率的三件事，事前拦一次比任何算法都便宜。 */
  async function assessImage(dataUrl) {
    const img = await new Promise(function (res, rej) { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
    const k = Math.min(1, 900 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); g.drawImage(img, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) gray[j] = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;

    // Laplacian 方差：越小越糊（经验阈值 60 以下基本糊）
    let sumL = 0, sumL2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        sumL += lap; sumL2 += lap * lap; n++;
      }
    }
    const meanL = n ? sumL / n : 0;
    const blur = n ? (sumL2 / n - meanL * meanL) : 0;

    // 光照均匀度：3×3 分块均值的极差
    const blocks = [];
    for (let by = 0; by < 3; by++) {
      for (let bx = 0; bx < 3; bx++) {
        let s2 = 0, c = 0;
        for (let y = Math.floor(by * h / 3); y < Math.floor((by + 1) * h / 3); y += 2) {
          for (let x = Math.floor(bx * w / 3); x < Math.floor((bx + 1) * w / 3); x += 2) { s2 += gray[y * w + x]; c++; }
        }
        if (c) blocks.push(s2 / c);
      }
    }
    const uneven = blocks.length ? Math.max.apply(null, blocks) - Math.min.apply(null, blocks) : 0;

    return {
      width: img.width, height: img.height,
      blur: Math.round(blur),
      blurry: blur < 60,
      uneven: Math.round(uneven),
      lightUneven: uneven > 70,
      hints: []
    };
  }

  /* ---------------------------------------------------------------- 预处理
     全局 Otsu 在光照不均的拍照图上会毁掉半边，改用 Sauvola 局部自适应阈值（16×16 块），
     再叠加 3×3 中值滤波去噪。二值结果明显更干净，tesseract 的笔画粘连会少很多。 */
  function sauvolaBinary(gray, w, h, block, k) {
    block = block || 16; k = k || 0.2;
    const W = w + 1, H = h + 1;
    const I = new Float64Array(W * H), I2 = new Float64Array(W * H);
    for (let y = 0; y < h; y++) {
      let rs = 0, rs2 = 0;
      for (let x = 0; x < w; x++) {
        const v = gray[y * w + x];
        rs += v; rs2 += v * v;
        I[(y + 1) * W + (x + 1)] = I[y * W + (x + 1)] + rs;
        I2[(y + 1) * W + (x + 1)] = I2[y * W + (x + 1)] + rs2;
      }
    }
    const out = new Uint8Array(w * h);
    const r = Math.max(4, Math.floor(block / 2));
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        const s1 = I[(y1 + 1) * W + (x1 + 1)] - I[y0 * W + (x1 + 1)] - I[(y1 + 1) * W + x0] + I[y0 * W + x0];
        const s2 = I2[(y1 + 1) * W + (x1 + 1)] - I2[y0 * W + (x1 + 1)] - I2[(y1 + 1) * W + x0] + I2[y0 * W + x0];
        const mean = s1 / area;
        const varr = Math.max(0, s2 / area - mean * mean);
        const std = Math.sqrt(varr);
        const t = mean * (1 + k * (std / 128 - 1));
        out[y * w + x] = gray[y * w + x] > t ? 255 : 0;
      }
    }
    return out;
  }

  function median3(gray, w, h) {
    const out = new Float32Array(gray.length);
    const buf = new Float32Array(9);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = Math.min(h - 1, Math.max(0, y + dy)), xx = Math.min(w - 1, Math.max(0, x + dx));
            buf[c++] = gray[yy * w + xx];
          }
        }
        for (let a = 1; a < 9; a++) { const t = buf[a]; let b = a - 1; while (b >= 0 && buf[b] > t) { buf[b + 1] = buf[b]; b--; } buf[b + 1] = t; }
        out[y * w + x] = buf[4];
      }
    }
    return out;
  }

  function preprocess(dataUrl, opts) {
    const o = Object.assign({ scale: 2, mode: 'sauvola', invert: false, block: 16, k: 0.2, median: true, deskew: false }, opts || {});
    return new Promise(function (resolve) {
      const img = new Image();
      img.onload = function () {
        const w = Math.max(1, Math.round(img.width * o.scale));
        const h = Math.max(1, Math.round(img.height * o.scale));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const g = cv.getContext('2d');
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, w, h);
        const data = g.getImageData(0, 0, w, h);
        const px = data.data;

        let gray = new Float32Array(w * h);
        for (let i = 0, j = 0; i < px.length; i += 4, j++) {
          gray[j] = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
        }
        if (o.median) gray = median3(gray, w, h);

        let bin;
        if (o.mode === 'none') {
          bin = gray; // 只用放大+去噪，保留灰度给 tesseract 自己判断
        } else if (o.mode === 'otsu') {
          const hist = new Uint32Array(256);
          for (let i = 0; i < gray.length; i++) hist[gray[i] | 0]++;
          let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
          let sumB = 0, wB = 0, best = 0, th = 128;
          for (let i = 0; i < 256; i++) {
            wB += hist[i]; if (!wB) continue;
            const wF = gray.length - wB; if (!wF) break;
            sumB += i * hist[i];
            const mB = sumB / wB, mF = (sum - sumB) / wF;
            const btw = wB * wF * (mB - mF) * (mB - mF);
            if (btw > best) { best = btw; th = i; }
          }
          bin = new Uint8Array(gray.length);
          for (let i = 0; i < gray.length; i++) bin[i] = gray[i] > th ? 255 : 0;
        } else {
          bin = sauvolaBinary(gray, w, h, o.block, o.k);
        }

        for (let i = 0, j = 0; i < px.length; i += 4, j++) {
          let v = bin[j];
          if (o.mode !== 'none') v = v ? 255 : 0;
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

  /* --------------------------------------------------- 低置信度片段打标
     tesseract 的 TSV 带每个词的置信度，低于 70 的用 [low]…[/low] 包起来，
     AI 规范化时就知道哪里该保守（保留 \square），哪里可以放心补。 */
  function markLowConfidence(words, threshold) {
    const th = threshold || 70;
    const out = [];
    for (const wd of words || []) {
      const t = (wd.text || '').trim();
      if (!t) continue;
      const conf = typeof wd.confidence === 'number' ? wd.confidence : (wd.conf || 0);
      out.push(conf < th ? '[low]' + t + '[/low]' : t);
    }
    return out.join(' ').replace(/\[\/low\]\s+\[low\]/g, ' ');
  }

  /* ------------------------------------------------------- Worker 单例
     以前每次识别都 createWorker() + terminate()：反复加载 WASM 和 chi_sim 语言包，
     第二张图还要再等好几秒。现在模块级复用同一个 worker，空闲 5 分钟才回收；
     识别任务串行排队，避免并发 setParameters/recognize 互相踩。 */
  let workerPromise = null;
  let workerIdleTimer = null;
  let jobQueue = Promise.resolve();
  const WORKER_IDLE_MS = 5 * 60 * 1000;

  function workerAlive() { return workerPromise; }

  async function getWorker(langs) {
    if (workerPromise) { touchWorker(); return workerPromise; }
    const T = await ensure();
    const base = scriptBase();
    workerPromise = T.createWorker(langs || 'chi_sim+eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base,
      langPath: base + 'lang',
      gzip: true,
      logger: function () {}
    }).catch(function (e) { workerPromise = null; throw e; });
    const w = await workerPromise;
    touchWorker();
    return w;
  }

  function touchWorker() {
    if (workerIdleTimer) clearTimeout(workerIdleTimer);
    workerIdleTimer = setTimeout(function () { disposeWorker().catch(function () {}); }, WORKER_IDLE_MS);
    if (workerIdleTimer && workerIdleTimer.unref) workerIdleTimer.unref();
  }

  async function disposeWorker() {
    const p = workerPromise;
    workerPromise = null;
    if (workerIdleTimer) { clearTimeout(workerIdleTimer); workerIdleTimer = null; }
    if (!p) return;
    try { const w = await p; await w.terminate(); } catch (e) {}
  }

  /* 单张图识别：进队列串行执行，进度回调 pct 百分比 */
  function recognize(src, opts, onPct) {
    const run = jobQueue.then(async function () {
      const w = await getWorker(opts && opts.langs);
      try {
        await w.setParameters({
          tessedit_pageseg_mode: String((opts && opts.psm) || '6'),
          preserve_interword_spaces: '1'
        });
      } catch (e) {}
      const r = await w.recognize(src);
      touchWorker();
      return r;
    });
    jobQueue = run.catch(function () {});
    return run;
  }

  /* ---------------------------------------------------------- 预处理变体
     三个变体按需生成：gray2x 先跑，置信度够就直接返回。
     旧实现不管需不需要都先把 2 倍放大 + 中值滤波 + Sauvola + Otsu 全算一遍
     （大图上每步都是几十毫秒的主线程循环），清晰截图白付两遍开销。 */
  function makeGray2x(dataUrl, onStage) {
    if (onStage) onStage('图像增强');
    return preprocess(dataUrl, { scale: 2, mode: 'none' });
  }

  function makeSauvola(grayDataUrl, opts) {
    const o = opts || {};
    return preprocess(grayDataUrl, { scale: 1, mode: 'sauvola', median: false, block: o.block || 16, k: o.k || 0.2 });
  }

  function makeOtsu(grayDataUrl) {
    return preprocess(grayDataUrl, { scale: 1, mode: 'otsu', median: false });
  }

  function aborted(signal) {
    return !!(signal && signal.aborted);
  }

  function abortError() {
    const e = new Error('已取消识别');
    e.name = 'AbortError';
    return e;
  }

  /* dataUrl -> 识别文字。默认中英混合。
     opts.stages 可指定变体顺序（默认 gray2x → sauvola → otsu）；
     opts.signal 支持中途取消；onProgress(pct, stage) 汇报进度。 */
  async function imageToText(dataUrl, onProgress, langs, opts) {
    const o = opts || {};
    const signal = o.signal || null;
    const notify = function (pct, stage) {
      if (!onProgress) return;
      try {
        // 老调用方只写 function(pct)：多传一个 stage 不影响它们
        onProgress(Math.max(0, Math.min(100, Math.round(pct))), stage || '');
      } catch (e) {}
    };
    const guard = function () { if (aborted(signal)) throw abortError(); };

    guard();
    notify(3, '加载识别组件');
    const T = await ensure();
    if (!T) throw new Error('OCR 组件不可用');
    guard();

    const order = Array.isArray(o.stages) && o.stages.length ? o.stages : ['gray2x', 'sauvola', 'otsu'];
    let gray = '';
    let best = null;

    for (let i = 0; i < order.length; i++) {
      const name = order[i];
      guard();
      let src;
      try {
        if (name === 'gray2x') {
          notify(10, '图像增强');
          src = gray = await makeGray2x(dataUrl, function (st) { notify(14, st); });
        } else if (name === 'sauvola') {
          if (!gray) gray = await makeGray2x(dataUrl);
          notify(20, '局部二值化');
          src = await makeSauvola(gray, o);
        } else if (name === 'otsu') {
          if (!gray) gray = await makeGray2x(dataUrl);
          notify(24, '全局二值化');
          src = await makeOtsu(gray);
        } else {
          src = dataUrl;
        }
      } catch (e) {
        continue;
      }
      if (!src) continue;
      guard();

      const base = 30 + i * 20;
      notify(base, '识别中');
      let r;
      try {
        r = await recognize(src, Object.assign({ langs: langs, psm: o.psm }, o), function () {});
      } catch (e) {
        if (aborted(signal)) throw abortError();
        continue;
      }
      guard();
      const d = (r && r.data) || {};
      const text = String(d.text || '').trim();
      if (!text) continue;
      const conf = typeof d.confidence === 'number' ? d.confidence : 0;
      if (!best || conf > best.conf || (conf === best.conf && text.length > best.text.length)) {
        best = { text: text, conf: conf, variant: name, words: d.words || [] };
      }
      notify(Math.min(96, base + 18), '识别完成');
      // 清晰截图：gray2x 已过 88 分，不必再跑两种二值化（它们更慢，且容易把细笔画抹掉）
      if (best.variant === 'gray2x' && best.conf >= 88) break;
      if (best.conf >= 92) break;
    }

    if (aborted(signal)) throw abortError();
    notify(100, '完成');
    if (!best) return '';
    lastRun = best;
    return best.text;
  }

  let lastRun = null;

  /* 用户是否配置了能看图的模型 */
  function hasVisionModel() {
    // 优先看「识图模型」；没单独配时 visionConfig 会自动退回支持图片的解题模型
    if (window.UI && window.UI.visionConfig) return !!window.UI.visionConfig();
    let cfg = null;
    try { cfg = JSON.parse(localStorage.getItem('mv_llm_v2') || 'null'); } catch (e) {}
    const v = cfg && cfg.vision;
    if (v && v.apiKey) return true;
    return false;
  }

  /* ---------------------------------------------------------------- 预处理
     ProcessOn 那类工具准确率高，一半功劳在预处理：先放大、灰度、拉对比、二值化，
     让字符边缘锐利。tesseract 对模糊小图几乎无解，对清晰黑白图能用得多。 */
  /* preprocess 只在上面定义一次（支持 mode: none/otsu/sauvola）。
     旧版 Otsu-only 实现曾重复声明在这里，因函数提升覆盖新版，导致三种变体全变成 Otsu，
     多版本取优形同虚设——已删除，勿再重复添加。 */

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
    // 必须走 API.url：直接写相对路径不会被加上 sharecode，线上会被网关 403
    const url = (window.API && window.API.url) ? window.API.url('/api/ai/ocr-fix') : 'api/ai/ocr-fix';
    const res = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, (window.API && window.API.authHeaders) ? window.API.authHeaders() : {}),
      cache: 'no-store',
      body: JSON.stringify({ text: rawText, problem: o.problem || '', llm: o.llm || null })
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'AI 规范化失败');
    return j.text || rawText;
  }

  /* 把 $ 配对补回来：OCR/AI 经常漏一个 $，整段公式就不渲染了 */
  function repairDelims(text) {
    let s = String(text || '');
    s = s.replace(/```(?:latex|tex|math)?/gi, '').replace(/```/g, '');
    const n = (s.match(/\$/g) || []).length;
    if (n % 2 === 1) {
      const last = s.lastIndexOf('$');
      s = last >= 0 ? s.slice(0, last) + s.slice(last + 1) : s + '$';
    }
    // 中文标点紧跟在 $$ 后面时收成 $
    s = s.replace(/\$\$(?=[，。；、,.;）)])/g, '$');
    return s.trim();
  }

  window.OCR = {
    assessImage: assessImage,
    markLowConfidence: markLowConfidence,
    lastRun: function () { return lastRun; },
    imageToText: imageToText,
    makeGray2x: makeGray2x,
    makeSauvola: makeSauvola,
    makeOtsu: makeOtsu,
    disposeWorker: disposeWorker,
    workerReady: function () { return !!workerPromise; },
    hasVisionModel: hasVisionModel,
    preprocess: preprocess,
    tidy: tidy,
    fixMathText: fixMathText,
    polishWithAI: polishWithAI,
    repairDelims: repairDelims
  };
})();
