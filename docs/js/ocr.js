/* 浏览器端 OCR：没有视觉模型时，把图片转成文字再交给 AI。
   tesseract.js 按需从 CDN 加载，加载失败也不影响其它功能。 */
(function () {
  'use strict';

  const CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  const VISION_MODEL = /gpt-4o|gpt-4\.1|o3|o4|claude|gemini|qwen.*vl|glm-4v|vision|llava|internvl/i;
  let loading = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('OCR 组件加载失败，请检查网络')); };
      document.head.appendChild(s);
    });
  }

  async function ensure() {
    if (window.Tesseract) return window.Tesseract;
    if (!loading) loading = loadScript(CDN);
    try { await loading; } catch (e) { loading = null; throw e; }
    if (!window.Tesseract) throw new Error('OCR 组件不可用');
    return window.Tesseract;
  }

  /* dataUrl -> 识别文字。lang 默认 chi_sim+eng（公式里的拉丁字母/数字也要认） */
  async function imageToText(dataUrl, onProgress, lang) {
    const T = await ensure();
    const worker = await T.createWorker(lang || 'chi_sim+eng', 1, {
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

  /* 清理 OCR 常见的公式噪声，但保留 LaTeX/运算符号 */
  function tidy(text) {
    return String(text || '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[。]$/m, '。')
      .trim();
  }

  window.OCR = { imageToText: imageToText, hasVisionModel: hasVisionModel, tidy: tidy };
})();
