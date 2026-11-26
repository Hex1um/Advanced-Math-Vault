/* 刷题热力图：纯原生 SVG，零第三方图表库
   - 26 周 × 7 天，鼠标悬停显示当天题量
   - 颜色用 5 档绿色，深浅两套主题都靠 CSS 变量自适应
   - 不依赖任何 DOM 框架：给一个容器和 { 'YYYY-MM-DD': count } 就能画 */
(function () {
  'use strict';

  const LEVELS_LIGHT = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];
  const LEVELS_DARK = ['#2a2f37', '#1f4d2b', '#2f7a41', '#3fa25a', '#57c878'];

  function isDark() {
    const root = document.documentElement;
    return root.getAttribute('data-theme') === 'dark' ||
      (root.classList.contains('dark')) ||
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches && !root.getAttribute('data-theme'));
  }

  function colorFor(n, dark) {
    const L = dark ? LEVELS_DARK : LEVELS_LIGHT;
    if (!n) return L[0];
    if (n <= 1) return L[1];
    if (n <= 3) return L[2];
    if (n <= 6) return L[3];
    return L[4];
  }

  function isoPlus8(ts) {
    return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }

  function renderHeatmap(container, dailyCounts, weeks) {
    if (!container) return;
    const counts = dailyCounts || {};
    const span = weeks || 26;
    const cell = 12;
    const gap = 3;
    const dark = isDark();

    const today = new Date();
    const totalDays = span * 7;
    const start = new Date(today.getTime() - (totalDays - 1) * 86400000);
    start.setDate(start.getDate() - start.getDay()); // 对齐到周日

    const rects = [];
    let col = 0;
    let total = 0;
    let max = 0;
    const cur = new Date(start);
    while (cur <= today) {
      const row = cur.getDay();
      const iso = isoPlus8(cur.getTime());
      const count = counts[iso] || 0;
      total += count;
      if (count > max) max = count;
      const x = col * (cell + gap);
      const y = row * (cell + gap);
      rects.push(
        '<rect x="' + x + '" y="' + y + '" width="' + cell + '" height="' + cell + '" rx="2" fill="' + colorFor(count, dark) + '">' +
        '<title>' + iso + '：' + count + ' 次提交</title></rect>'
      );
      if (row === 6) col++;
      cur.setDate(cur.getDate() + 1);
    }

    const width = (col + 1) * (cell + gap);
    const height = 7 * (cell + gap);
    container.innerHTML =
      '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" style="max-width:' + width + 'px" role="img" aria-label="刷题热力图">' +
      rects.join('') +
      '</svg>' +
      '<div class="small muted" style="margin-top:6px">近 ' + span + ' 周共 ' + total + ' 次提交' +
      (max ? '，单日最多 ' + max + ' 次' : '') + '</div>';
  }

  window.MathVaultHeatmap = { renderHeatmap: renderHeatmap };
})();
