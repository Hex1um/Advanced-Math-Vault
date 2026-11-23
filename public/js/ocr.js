/* 浏览器端 OCR：没有视觉模型时，把图片转成文字再交给 AI。
   tesseract.js 与中英文语言包全部放在 vendor/tesseract 下，离线可用，不依赖外网 CDN
   （国内 jsDelivr 常被墙，走 CDN 等于这个功能对大多数用户不可用）。 */
(function () {
  'use strict';

  const BASE = 'vendor/tesseract/';
  const VISION_MODEL = /gpt-4o|gpt-4\.1|o3|o4|claude|gemini|qwen.*vl|glm-4v|vision|llava|internvl/i;
  let loading = null;

  /* 以 ocr.js 自身的地址推 vendor 目录，兼容 file:// 与 Pages 子路径 */
  function scriptBase() {
    const s = document.querySelector('script[src*="ocr.js"]');
    if (s) {
      const src = s.getAttribute('src') || '';
      return src.replace(/[^/]*$/, '') + BASE;
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

  /* dataUrl -> 识别文字。默认中英混合（题目里的中文说明 + 拉丁字母/数字） */
  async function imageToText(dataUrl, onProgress, langs) {
    const T = await ensure();
    const base = scriptBase();
    const worker = await T.createWorker(langs || 'chi_sim+eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base,              // 同目录有 tesseract-core-simd.wasm.js
      langPath: base + 'lang',     // lang/chi_sim.traineddata.gz 与 eng.traineddata.gz
      gzip: true,
      logger: function (m) {
        if (m && m.status === 'recognizing text' && onProgress) onProgress(Math.round((m.progress || 0) * 100));
      }
    });
    try {
      const r = await worker.recognize(dataUrl);
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

  /* 清理 OCR 噪声，保留公式与运算符 */
  function tidy(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/(^|\n)\s*[|｜]\s*/g, '$1')
      .trim();
  }

  window.OCR = { imageToText: imageToText, hasVisionModel: hasVisionModel, tidy: tidy };
})();
