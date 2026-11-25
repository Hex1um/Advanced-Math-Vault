'use strict';
/**
 * 错题复习调度（FSRS 思路的确定性简化版）
 *
 * 为什么不直接照搬 FSRS-4.5 的 17 个参数：那套参数需要用真实复习日志拟合，
 * 本站的数据量（几百张卡）拟合出来不可信，反而不可解释。
 * 这里保留 FSRS 的骨架与字段语义，权重取常用的经验值并全部写成常量，
 * 保证：同一张卡 + 同一个评分 → 永远同一个下次复习时间（可测、可解释、可手改）。
 *
 * 字段：
 *   stability    稳定度（天）：多久之后回忆成功率约 90%
 *   difficulty   难度 1..10：越高增长越慢
 *   reps         复习次数
 *   lapses       遗忘次数（评 again 的次数）
 *   state        new | learning | review | relearning
 *   intervalDays 下次间隔（天，整数，与旧数据兼容）
 *   lastReviewAt / nextReviewAt  毫秒时间戳
 */

const DAY = 86400000;

/* 首次评分的初始稳定度（天） */
const FIRST_STABILITY = [0.3, 1.0, 2.4, 4.0]; // again / hard / good / easy
/* 稳定度增长倍率：评得越轻松，涨得越快 */
const GROWTH = [1.0, 1.55, 1.95, 2.35];
/* 难度增量 */
const DIFFICULTY_DELTA = [0.8, 0.6, -0.1, -0.5];
const MAX_STABILITY = 365;
const MIN_STABILITY = 0.3;

const GRADE_NAMES = ['again', 'hard', 'good', 'easy'];

function gradeToIndex(rating) {
  if (typeof rating === 'number' && Number.isFinite(rating)) {
    return Math.max(0, Math.min(3, Math.round(rating)));
  }
  const s = String(rating == null ? '' : rating).trim().toLowerCase();
  const byName = GRADE_NAMES.indexOf(s);
  if (byName >= 0) return byName;
  if (s === 'forgot' || s === 'fail' || s === '忘记' || s === '忘了') return 0;
  if (s === '吃力' || s === '难') return 1;
  if (s === '良好' || s === '一般') return 2;
  if (s === '简单' || s === '容易') return 3;
  return 2;
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function emptyCard(now) {
  return {
    stability: 0,
    difficulty: 5,
    reps: 0,
    lapses: 0,
    state: 'new',
    intervalDays: 0,
    lastReviewAt: 0,
    nextReviewAt: now || Date.now()
  };
}

/** 兼容历史数据：只有 intervalDays / nextReviewAt 的旧记录 */
function normalizeCard(input, now) {
  const c = Object.assign(emptyCard(now), input || {});
  if (!c.stability) {
    c.stability = Number(c.intervalDays) > 0 ? Number(c.intervalDays) : 0;
  }
  if (!c.state || c.state === 'new') {
    if (c.reps > 0) c.state = 'review';
  }
  c.difficulty = clamp(c.difficulty, 1, 10);
  c.stability = Math.max(0, Number(c.stability) || 0);
  return c;
}

/**
 * 计算下一次复习。
 * @param {object} card 现有卡（可为空/旧格式）
 * @param {number|string} rating again|hard|good|easy（也接受 0..3）
 * @param {number} [now]
 * @returns {object} 新卡（不修改入参）
 */
function schedule(card, rating, now) {
  const t = Number(now) || Date.now();
  const c = normalizeCard(card, t);
  const g = gradeToIndex(rating);

  let stability = c.stability;
  let difficulty = c.difficulty;
  const reps = (c.reps || 0) + 1;
  let lapses = c.lapses || 0;
  let state = c.state || 'new';

  if (g === 0) {
    // 忘了：稳定度腰斩、难度上调；稳定度跌破 1 天说明这张卡要从头学
    stability = Math.max(MIN_STABILITY, stability * 0.45);
    difficulty = clamp(difficulty + DIFFICULTY_DELTA[0], 1, 10);
    lapses += 1;
    state = stability < 1 ? 'relearning' : 'review';
  } else if (stability <= 0) {
    stability = FIRST_STABILITY[g];
    difficulty = clamp(difficulty + DIFFICULTY_DELTA[g], 1, 10);
    state = 'learning';
  } else {
    // 难度越高，同样的评分带来的增长越小
    const damp = 1 - 0.05 * (difficulty - 5);
    stability = Math.min(MAX_STABILITY, stability * GROWTH[g] * Math.max(0.6, damp));
    difficulty = clamp(difficulty + DIFFICULTY_DELTA[g], 1, 10);
    state = 'review';
  }

  // 难度修正间隔：难度 10 打 0.7 折，难度 1 略微延长；上限与稳定度一致，
  // 否则难度修正会把 365 天的上限顶到 450+ 天
  const intervalDays = Math.min(MAX_STABILITY, Math.max(1, Math.round(stability * (1 - 0.06 * (difficulty - 5)))));

  return {
    stability: Math.round(stability * 1000) / 1000,
    difficulty: Math.round(difficulty * 100) / 100,
    reps: reps,
    lapses: lapses,
    state: state,
    intervalDays: intervalDays,
    lastReviewAt: t,
    nextReviewAt: t + intervalDays * DAY,
    lastGrade: GRADE_NAMES[g],
    lastResult: g === 0 ? 'fail' : 'pass'
  };
}

/** 逾期天数（未到期为负），用于今日复习排序 */
function overdueDays(card, now) {
  const t = Number(now) || Date.now();
  const due = Number(card && card.nextReviewAt) || 0;
  if (!due) return 0;
  return Math.floor((t - due) / DAY);
}

function isDue(card, now) {
  const t = Number(now) || Date.now();
  return (Number(card && card.nextReviewAt) || 0) <= t;
}

module.exports = {
  DAY,
  GRADE_NAMES,
  gradeToIndex,
  emptyCard,
  normalizeCard,
  schedule,
  overdueDays,
  isDue,
  MAX_STABILITY
};
