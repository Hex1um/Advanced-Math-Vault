/* 防丢稿本地草稿箱
   长解答、发帖、投稿页面刷新/误关就丢稿是最伤的体验问题之一。
   这里用 localStorage 做 7 天 TTL 的草稿：输入 400ms 防抖落盘，恢复时只填空输入框，
   不会覆盖用户已经敲进去的内容。 */
(function () {
  'use strict';

  const PREFIX = 'mv_draft_v1:';
  const TTL_MS = 7 * 86400000;

  function save(key, value) {
    try {
      const text = String(value == null ? '' : value);
      if (!text.trim()) {
        localStorage.removeItem(PREFIX + key);
        return;
      }
      localStorage.setItem(PREFIX + key, JSON.stringify({ v: text, t: Date.now() }));
    } catch (e) { /* 隐私模式/配额满：静默降级，不影响答题 */ }
  }

  function load(key) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (!raw) return '';
      const parsed = JSON.parse(raw);
      if (Date.now() - (parsed.t || 0) > TTL_MS) {
        localStorage.removeItem(PREFIX + key);
        return '';
      }
      return parsed.v || '';
    } catch (e) {
      return '';
    }
  }

  function clear(key) {
    try { localStorage.removeItem(PREFIX + key); } catch (e) { /* ignore */ }
  }

  /** 绑定到任意 <textarea>，返回清理函数供视图 cleanup() 调用 */
  function bindTextarea(textarea, key, onRestored) {
    if (!textarea) return function () {};
    const saved = load(key);
    if (saved && !textarea.value) {
      textarea.value = saved;
      if (onRestored) onRestored(saved);
    }
    let timer = null;
    const handler = function () {
      clearTimeout(timer);
      timer = setTimeout(function () { save(key, textarea.value); }, 400);
    };
    textarea.addEventListener('input', handler);
    // 页面隐藏/刷新前立即落盘，避免最后 400ms 的输入丢失
    const flush = function () { save(key, textarea.value); };
    window.addEventListener('pagehide', flush);
    return function () {
      clearTimeout(timer);
      textarea.removeEventListener('input', handler);
      window.removeEventListener('pagehide', flush);
    };
  }

  /** 绑定任意输入框（标题等 input），语义同 textarea */
  function bindInput(input, key) {
    if (!input) return function () {};
    const saved = load(key);
    if (saved && !input.value) input.value = saved;
    let timer = null;
    const handler = function () {
      clearTimeout(timer);
      timer = setTimeout(function () { save(key, input.value); }, 400);
    };
    input.addEventListener('input', handler);
    return function () {
      clearTimeout(timer);
      input.removeEventListener('input', handler);
    };
  }

  window.DraftStore = { save: save, load: load, clear: clear, bindTextarea: bindTextarea, bindInput: bindInput };
})();
