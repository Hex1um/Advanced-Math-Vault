/**
 * 等级 / 经验 / 难度分级（纯函数，无状态）
 *
 * 从 lib/core.js 抽出来的原因：判题、做题、排行榜、后台到处都要算「这道题几级」
 * 「多少经验升级」，而它们全是纯函数 —— 放在 2000 行的闭包里既不好找，也没法单测。
 *
 * 曲线：level = floor(sqrt(exp / XP_CURVE)) + 1，即升到 n 级需要 25(n-1)² 经验。
 */
'use strict';

const { TUNING } = require('./config');

const LEVELS = [
  { max: 3, name: '基础巩固', color: '#4ade80' },
  { max: 5, name: '常规练习', color: '#38bdf8' },
  { max: 7, name: '综合提高', color: '#fbbf24' },
  { max: 8, name: '考研冲刺', color: '#fb923c' },
  { max: 9, name: '竞赛入门', color: '#f87171' },
  { max: 10, name: '竞赛压轴', color: '#c084fc' }
];

function levelOf(d) {
  const n = Math.max(1, Math.min(10, Number(d) || 5));
  for (const l of LEVELS) if (n <= l.max) return l;
  return LEVELS[LEVELS.length - 1];
}

function clampScore(v, fallback, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max || 10, n));
}

const DIFF_MAX = 15;

function levelInfo(exp) {
  const e = Math.max(0, exp || 0);
  const k = TUNING.XP_CURVE;
  const level = Math.floor(Math.sqrt(e / k)) + 1;
  const cur = Math.pow(level - 1, 2) * k;
  const next = Math.pow(level, 2) * k;
  return { level, exp: e, cur, next, progress: Math.min(1, (e - cur) / Math.max(1, next - cur)) };
}

/* 做题经验：难度/思维量/计算量给基数；点过答案或问过 AI 打折（不是自己做的就不该给满）。
   下限 3 分：哪怕全错也不至于给 0，避免「努力了但没分」的挫败感。 */
function xpForProblem(p, solve) {
  const base = 10 + p.difficulty * 3 + p.thinking + p.calc;
  if (!solve) return base;
  let factor = 1;
  if (solve.revealed) factor -= 0.4;
  if (solve.askedAI) factor -= 0.2;
  return Math.max(3, Math.round(base * Math.max(0.4, factor)));
}

module.exports = {
  LEVELS: LEVELS,
  DIFF_MAX: DIFF_MAX,
  levelOf: levelOf,
  clampScore: clampScore,
  levelInfo: levelInfo,
  xpForProblem: xpForProblem
};
