'use strict';
/**
 * 内存限流：近似滑动窗口 + 容量上限。
 *
 * 旧实现是固定窗口计数器，且 buckets 无上限——扫描器换着 IP 打，
 * Map 会一直涨到 OOM。这里做两件事：
 *   1. 用「上一窗口计数按剩余时间加权」近似滑动窗口，比固定窗口平滑；
 *   2. 桶数超过 MAX_BUCKETS 时先清过期、再按最早重置淘汰。
 */

const DEFAULT_MAX_BUCKETS = 20000;

function createRateLimiter(options) {
  const o = options || {};
  const maxBuckets = Number(o.maxBuckets || process.env.RATE_LIMIT_MAX_BUCKETS || DEFAULT_MAX_BUCKETS);
  const buckets = new Map();

  function evict(now) {
    // 先清已过期
    for (const [k, b] of buckets) {
      if (now >= b.reset + b.windowMs) buckets.delete(k);
    }
    if (buckets.size < maxBuckets) return;
    // 还超就按重置时间从早到晚淘汰
    const entries = [...buckets.entries()].sort((a, b) => a[1].reset - b[1].reset);
    const drop = Math.max(1, Math.ceil(entries.length * 0.1));
    for (let i = 0; i < drop && i < entries.length; i++) buckets.delete(entries[i][0]);
  }

  /**
   * 记一次访问并判断是否放行。
   * @param {string} key
   * @param {number} limit 窗口内允许次数
   * @param {number} windowMs 窗口长度
   * @returns {boolean} true 放行 / false 限流
   */
  function hit(key, limit, windowMs) {
    const now = Date.now();
    const win = Number(windowMs) || 60000;
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxBuckets) evict(now);
      b = { cur: 0, prev: 0, reset: now + win, windowMs: win };
      buckets.set(key, b);
    } else if (now >= b.reset + b.windowMs) {
      b.cur = 0; b.prev = 0; b.windowMs = win; b.reset = now + win;
    } else if (now >= b.reset) {
      b.prev = b.cur; b.cur = 0; b.windowMs = win; b.reset = now + win;
    }
    b.cur += 1;
    const elapsed = Math.max(0, now - (b.reset - b.windowMs));
    const weight = Math.max(0, 1 - elapsed / b.windowMs);
    const approx = b.cur + b.prev * weight;
    return approx <= limit;
  }

  function sweep() {
    const now = Date.now();
    for (const [k, b] of buckets) if (now >= b.reset + b.windowMs) buckets.delete(k);
  }

  function stats() {
    return { buckets: buckets.size, maxBuckets: maxBuckets };
  }

  return { hit, sweep, stats, buckets };
}

module.exports = { createRateLimiter, DEFAULT_MAX_BUCKETS };
