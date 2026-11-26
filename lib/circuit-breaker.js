/**
 * AI 通道熔断器与动态健康度排序（零依赖）
 *
 * 问题：lib/ai.js 按 FREE_PROVIDERS 顺序串行尝试，单通道超时 22s。
 * 排在前面的免费节点一旦宕机，每个请求都要白等 22 秒才切换，体感就是「卡死」。
 *
 * 做法：经典三态熔断（CLOSED / OPEN / HALF_OPEN）+ 指数滑动平均延迟。
 *   - 连续失败 3 次 → 打开 3 分钟，期间直接跳过；
 *   - 冷却结束进入半开，只放一次试探：成功则闭合，失败立刻重新打开；
 *   - 同优先级通道按 EMA 延迟升序，快节点自然排前面。
 *
 * 注意：熔断只影响「先后顺序」，不会把全部通道都永久拉黑 ——
 * 若都在熔断中，仍会挑最早到期的那个试一次，避免彻底不可用。
 */
'use strict';

class ChannelBreaker {
  constructor({
    failureThreshold = 3,
    cooldownMs = 180000,
    emaAlpha = 0.3,
  } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.emaAlpha = emaAlpha;
    this.channels = new Map();
  }

  _get(id) {
    if (!this.channels.has(id)) {
      this.channels.set(id, {
        state: 'CLOSED',
        failures: 0,
        openUntil: 0,
        emaLatencyMs: 3000,
        successes: 0,
        totalFailures: 0,
      });
    }
    return this.channels.get(id);
  }

  /** 判断当前通道是否允许放行 */
  canAttempt(id, now = Date.now()) {
    const ch = this._get(id);
    if (ch.state === 'CLOSED') return true;
    if (ch.state === 'OPEN' && now >= ch.openUntil) {
      ch.state = 'HALF_OPEN';
      return true;
    }
    return false;
  }

  recordSuccess(id, latencyMs) {
    const ch = this._get(id);
    ch.state = 'CLOSED';
    ch.failures = 0;
    ch.successes++;
    const ms = Math.max(1, Number(latencyMs) || 1);
    ch.emaLatencyMs = Math.round(ch.emaLatencyMs * (1 - this.emaAlpha) + ms * this.emaAlpha);
  }

  recordFailure(id, now = Date.now()) {
    const ch = this._get(id);
    ch.failures++;
    ch.totalFailures++;
    if (ch.state === 'HALF_OPEN' || ch.failures >= this.failureThreshold) {
      ch.state = 'OPEN';
      ch.openUntil = now + this.cooldownMs;
    }
  }

  /** 过滤掉熔断中的通道，并按平均延迟升序优选同优先级通道 */
  rankCandidates(candidates) {
    const now = Date.now();
    const available = candidates.filter((c) => this.canAttempt(c.id || c.name, now));
    if (available.length === 0 && candidates.length > 0) {
      const soonest = candidates.slice().sort(
        (a, b) => this._get(a.id || a.name).openUntil - this._get(b.id || b.name).openUntil
      )[0];
      return [soonest];
    }
    return available.sort((a, b) => {
      const pa = a.priority == null ? 10 : a.priority;
      const pb = b.priority == null ? 10 : b.priority;
      if (pa !== pb) return pa - pb;
      return this._get(a.id || a.name).emaLatencyMs - this._get(b.id || b.name).emaLatencyMs;
    });
  }

  snapshot() {
    return Object.fromEntries(this.channels.entries());
  }
}

module.exports = { ChannelBreaker };
