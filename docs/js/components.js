/* 前端公共组件（零依赖，挂在 window.Components）
 *
 * 抽出来的原因：题库列表、错题本、试卷预览各自手写了一遍「题目行 / 标签 / 统计条」，
 * 改一处样式要同步三处，还经常漏。这里只放「纯函数 → HTML 字符串」的组件，
 * 事件绑定仍然留在各视图里（避免组件偷偷持有 DOM 引用导致内存泄漏）。
 */
(function () {
  'use strict';

  const esc = function (s) { return window.Md ? window.Md.esc(s) : String(s == null ? '' : s); };
  const tex = function (s) { return window.Md ? window.Md.inlineTex(s) : esc(s); };

  /** 标签 chips：tags 支持字符串数组，或 { name, count } 对象数组 */
  function tagChips(tags, opts) {
    const o = opts || {};
    if (!Array.isArray(tags) || !tags.length) return '';
    return '<div class="tags">' + tags.map(function (t) {
      const name = typeof t === 'string' ? t : (t && t.name) || '';
      const count = t && typeof t === 'object' && t.count !== undefined ? '<span class="n">' + t.count + '</span>' : '';
      const cls = o.className ? ' ' + o.className : '';
      return '<span class="tag' + cls + '">' + esc(name) + count + '</span>';
    }).join('') + '</div>';
  }

  /** 统计条：[{k, v, unit}] */
  function statStrip(items) {
    if (!Array.isArray(items) || !items.length) return '';
    const cols = items.length;
    return '<div class="stat-strip" style="grid-template-columns:repeat(' + cols + ',1fr)">'
      + items.map(function (it) {
        return '<div class="stat"><div class="k">' + esc(it.k) + '</div><div class="v">' + (it.v === undefined || it.v === null ? '—' : it.v)
          + (it.unit ? '<small>' + esc(it.unit) + '</small>' : '') + '</div></div>';
      }).join('')
      + '</div>';
  }

  /** 空状态：标题 + 说明 + 可选操作 */
  function emptyState(title, desc, actionHtml) {
    return '<div class="empty"><b>' + esc(title) + '</b>' + esc(desc || '')
      + (actionHtml ? '<div style="margin-top:14px">' + actionHtml + '</div>' : '')
      + '</div>';
  }

  /** 自评按钮组（错题本 / 复习队列共用） */
  const RATINGS = [
    { key: 'again', label: '忘了', hint: '完全想不起来，明天再来' },
    { key: 'hard', label: '吃力', hint: '想起来了但很费劲' },
    { key: 'good', label: '良好', hint: '正常回忆起来' },
    { key: 'easy', label: '简单', hint: '一眼就会，隔久一点再复习' }
  ];

  function ratingBar(code, opts) {
    const o = opts || {};
    return '<span class="rate-btns"' + (o.attr ? ' ' + o.attr : '') + ' data-code="' + esc(code) + '">'
      + RATINGS.map(function (r) {
        return '<button class="chip" data-rate="' + r.key + '" data-code="' + esc(code) + '" title="' + r.hint + '">' + r.label + '</button>';
      }).join('')
      + '</span>';
  }

  /**
   * 题目行（题库 / 错题本共用）
   * @param {object} p 题目（列表接口的 visibleProblem 形状）
   * @param {{showPaperAdd?: boolean, metaHtml?: string, stateHtml?: string, href?: string, paperAdded?: boolean}} [opts]
   */
  function problemRow(p, opts) {
    const o = opts || {};
    const lv = window.UI && window.UI.levelOf ? window.UI.levelOf(p.difficulty) : { color: '#999' };
    const rate = p.attemptCount
      ? Math.round((p.solvedCount / Math.max(1, p.attemptCount + p.solvedCount)) * 100) + '%'
      : '—';
    const href = o.href || ('#/problem/' + p.code);
    const addBtn = o.showPaperAdd === false
      ? ''
      : '<button class="paper-add" data-code="' + esc(p.code) + '" title="加入试卷">' + (o.paperAdded ? '✓' : '+') + '</button>';
    return '<div class="prow' + (p.solved ? ' solved' : '') + '" data-code="' + esc(p.code) + '">'
      + '<div class="pstate">' + (o.stateHtml || (p.solved ? '<span class="ok">✓</span>' : '<span class="none"></span>')) + '</div>'
      + '<div class="pcode">' + esc(p.code) + '</div>'
      + '<div class="pmain">'
      + '<div class="pexcerpt"><a href="' + href + '">' + tex(p.excerpt || p.title || '') + '</a></div>'
      + (window.UI && window.UI.tagBadges ? window.UI.tagBadges(p, { showKind: true }) : tagChips(p.tags))
      + (window.UI && window.UI.scoreBars ? window.UI.scoreBars(p, true) : '')
      + (o.extraHtml || '')
      + '</div>'
      + '<div class="pdiff">' + (window.UI && window.UI.levelBadge ? window.UI.levelBadge(p)
        : '<span style="width:6px;height:6px;border-radius:50%;background:' + lv.color + '"></span>')
      + '<span class="rate">通过率 ' + rate + '</span></div>'
      + '<div class="pmeta">' + addBtn
      + '<span>' + (p.solvedCount || 0) + ' 通过</span>'
      + (o.metaHtml || '')
      + '</div>'
      + '</div>';
  }

  /** 分页条：页码数组 + 回调绑定交给 UI.pagination（已有实现） */
  function pager(page, pages, onPick) {
    if (!window.UI || !window.UI.pagination) return document.createDocumentFragment();
    return window.UI.pagination(page, pages, onPick);
  }

  const Components = {
    RATINGS: RATINGS,
    tagChips: tagChips,
    statStrip: statStrip,
    emptyState: emptyState,
    ratingBar: ratingBar,
    problemRow: problemRow,
    pager: pager
  };

  if (typeof window !== 'undefined') window.Components = Components;
  if (typeof module !== 'undefined' && module.exports) module.exports = Components;
})();
