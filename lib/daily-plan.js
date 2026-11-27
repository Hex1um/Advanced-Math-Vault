'use strict';
/**
 * 每日一积的连排表。
 *
 * 不写题号，只记**题干指纹**：题库是从 data/batch-*.json 重建的，每重建一次 code 就重排一次
 * （2026-11-27 那次重建把 HS7542–HS7560 全变成了概率题，排期直接错位）。
 * 每天按指纹在已过审的题里认人；认不到就跳过并回落伪随机，不会开出别的题。
 *
 * 2026-11-26 起：一份 20 道不定积分练习单（第 4 题库里有两份同题，取编号靠前的那道）。
 */
const start = '2026-11-26';

/* sig 取题干里 $$...$$ 的数学部分；比对前会压缩空白与 \, \mathrm{d} 这类排版差异 */
const entries = [
  { no: 1, sig: "\\int\\frac{\\tan x}{3\\sin^{2}x+2\\cos^{2}x}\\,\\mathrm{d}x." },
  { no: 2, sig: "\\int\\frac{x^{2}+1}{x\\sqrt{x^{4}+1}}\\,\\mathrm{d}x." },
  { no: 3, sig: "\\int\\frac{\\mathrm{d}x}{x^{2}\\sqrt{1+x^{2}}}." },
  { no: 4, sig: "\\int\\frac{\\ln x}{x\\sqrt{1+\\ln x}}\\,\\mathrm{d}x" },
  { no: 5, sig: "\\int\\arctan\\sqrt{x}\\,\\mathrm{d}x." },
  { no: 6, sig: "\\int x\\tan x\\sec^{4}x\\,\\mathrm{d}x." },
  { no: 7, sig: "\\int\\frac{x\\mathrm{e}^{x}}{\\sqrt{\\mathrm{e}^{x}-2}}\\,\\mathrm{d}x." },
  { no: 8, sig: "\\int\\frac{x^{2}+20}{\\left(x\\sin x+5\\cos x\\right)^{2}}\\,\\mathrm{d}x." },
  { no: 9, sig: "\\int\\frac{x+1}{\\sqrt{x-x^{2}}}\\,\\mathrm{d}x." },
  { no: 10, sig: "\\int\\frac{1+\\sin x}{1+\\cos x}\\,\\mathrm{e}^{x}\\,\\mathrm{d}x." },
  { no: 11, sig: "\\int\\frac{\\ln\\left(1+\\mathrm{e}^{-x}\\right)}{1+\\mathrm{e}^{x}}\\,\\mathrm{d}x." },
  { no: 12, sig: "\\int\\frac{\\mathrm{d}x}{\\sin 2x+2\\sin x}." },
  { no: 13, sig: "\\int\\frac{\\mathrm{d}x}{\\left(1+\\mathrm{e}^{x}\\right)^{2}}." },
  { no: 14, sig: "\\int\\frac{\\mathrm{e}^{\\arctan x}}{\\sqrt{\\left(1+x^{2}\\right)^{3}}}\\,\\mathrm{d}x." },
  { no: 15, sig: "\\int\\frac{\\mathrm{d}x}{\\sin x\\cos^{3}x}." },
  { no: 16, sig: "\\int\\frac{\\sqrt{x}}{1+\\sqrt{1+x}}\\,\\mathrm{d}x." },
  { no: 17, sig: "\\int\\frac{\\mathrm{d}x}{\\left(2x-1\\right)\\sqrt{x-x^{2}}}." },
  { no: 18, sig: "\\int\\frac{x^{4}}{x^{4}+5x^{2}+4}\\,\\mathrm{d}x." },
  { no: 19, sig: "\\int\\frac{\\cos x+x\\sin x}{\\left(x+\\cos x\\right)^{2}}\\,\\mathrm{d}x." },
  { no: 20, sig: "\\int\\frac{\\left(1+x^{2}\\right)\\arcsin x}{x^{2}\\sqrt{1-x^{2}}}\\,\\mathrm{d}x." },
];

/** 某天对应的序号，不在排期内返回 -1（调用方回落伪随机） */
function indexFor(key) {
  const toDay = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  };
  const a = toDay(start);
  const b = toDay(key);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return -1;
  const i = Math.round((b - a) / 86400000);
  return i >= 0 && i < entries.length ? i : -1;
}

/* 比对前的归一化：抹掉 \, \left \mathrm{d} 这类纯排版差异，只留「字」 */
function compact(s) {
  return String(s || '')
    .replace(/\\left|\\right|\\displaystyle|\\,|\\;|\\!|\\quad|\\qquad/g, '')
    .replace(/\\mathrm\{d\}/g, 'd')
    .replace(/\\text\{([^}]*)\}/g, '$1')
    .replace(/\s+/g, '')
    .replace(/\$/g, '')
    .toLowerCase();
}

/* 指纹 -> code 的缓存：题库被导入/重建后长度会变，长度一变就整体作废重算 */
let cache = new Map();
let cacheBasis = -1;

/**
 * 按指纹在已过审的题里认人。
 * @param {Array} problems db.problems
 * @param {{sig?:string, code?:string}} entry
 * @returns {{problem:object|null, ambiguous:number}}
 */
function resolve(problems, entry) {
  const list = Array.isArray(problems) ? problems : [];
  if (!entry) return { problem: null, ambiguous: 0 };

  /* 有 code 且还在，直接用（给「临时指定某天」留口子） */
  if (entry.code) {
    const byCode = list.find((p) => p.code === entry.code && p.status === 'approved');
    if (byCode) return { problem: byCode, ambiguous: 0 };
  }

  const sig = compact(entry.sig);
  if (!sig) return { problem: null, ambiguous: 0 };

  if (cacheBasis !== list.length) { cache = new Map(); cacheBasis = list.length; }
  const cached = cache.get(sig);
  if (cached) {
    const hit = list.find((p) => p.code === cached && p.status === 'approved');
    if (hit) return { problem: hit, ambiguous: 0 };
  }

  const hits = list.filter((p) => p.status === 'approved' && compact(p.statement).includes(sig));
  if (!hits.length) return { problem: null, ambiguous: 0 };
  /* 同一道题在库里可能有多份（换元积分那类重复题）：按编号取靠前的那份 */
  hits.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  cache.set(sig, hits[0].code);
  return { problem: hits[0], ambiguous: hits.length };
}

module.exports = { start, entries, indexFor, compact, resolve };
