/* 拍照识别的预处理增强：去掉笔记本横线、压掉局部阴影
   学生拍纸质笔记时，横格线会穿过分数线与积分号，Tesseract 会把它们当成笔画，
   切分直接崩。这里只做两件确定性的事：
     1. 某一行黑色像素占比超过阈值 → 判定为通栏横线，擦成白底；
     2. 上下都是白底的孤立黑像素才擦，避免误伤文字笔画。
   纯 Canvas 像素操作，不引入任何依赖。 */
(function () {
  'use strict';

  /**
   * @param {ImageData} imageData 已灰度/二值化后的图像（黑字 0，白底 255）
   * @param {number} coverageRatio 某行黑色像素占比超过该值视为通栏横线
   */
  function removeRuledLines(imageData, coverageRatio) {
    if (!imageData || !imageData.data) return imageData;
    const ratio = coverageRatio || 0.55;
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;
    const darkRow = new Uint8Array(height);

    for (let y = 0; y < height; y++) {
      let dark = 0;
      const rowOffset = y * width * 4;
      for (let x = 0; x < width; x++) {
        if (data[rowOffset + x * 4] < 128) dark++;
      }
      if (width && dark / width >= ratio) darkRow[y] = 1;
    }

    for (let y = 1; y < height - 1; y++) {
      if (!darkRow[y]) continue;
      // 超过 3 行连续的深色带多半是表格边框/阴影，不擦
      if (darkRow[y - 1] && darkRow[y + 1] && y + 2 < height && darkRow[y + 2]) continue;
      for (let x = 0; x < width; x++) {
        const up = data[((y - 1) * width + x) * 4];
        const down = data[((y + 1) * width + x) * 4];
        if (up >= 128 && down >= 128) {
          const idx = (y * width + x) * 4;
          data[idx] = 255;
          data[idx + 1] = 255;
          data[idx + 2] = 255;
        }
      }
    }
    return imageData;
  }

  /** 局部阴影压制：对每个像素按「本块最暗值」做轻度抬亮，避免整块发黑影响二值化 */
  function reduceShadow(imageData, block) {
    if (!imageData || !imageData.data) return imageData;
    const size = block || 32;
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;
    for (let by = 0; by < height; by += size) {
      for (let bx = 0; bx < width; bx += size) {
        let min = 255;
        for (let y = by; y < Math.min(by + size, height); y += 2) {
          for (let x = bx; x < Math.min(bx + size, width); x += 2) {
            const v = data[(y * width + x) * 4];
            if (v < min) min = v;
          }
        }
        if (min > 210) continue; // 本来就亮，不用管
        const lift = Math.min(70, (210 - min) * 0.6);
        for (let y = by; y < Math.min(by + size, height); y++) {
          for (let x = bx; x < Math.min(bx + size, width); x++) {
            const idx = (y * width + x) * 4;
            const v = Math.min(255, data[idx] + lift);
            data[idx] = v;
            data[idx + 1] = v;
            data[idx + 2] = v;
          }
        }
      }
    }
    return imageData;
  }

  window.OcrPreprocess = { removeRuledLines: removeRuledLines, reduceShadow: reduceShadow };
})();
