'use strict';
/**
 * 每日一积的连排表。
 *
 * 默认是「按日期哈希伪随机 + 最近 30 天不重复」（见 lib/core.js 的 dailyProblem）。
 * 但如果这里给了日期和题号，就从 start 那天起按顺序一天一道，走完自动回到伪随机，
 * 不需要再去改 db.daily（那是缓存，会被重建）。
 *
 * 2026-11-26 的排期：一份 20 道不定积分练习单。
 * 其中第 4 题（lnx/(x√(1+lnx))）库里本来就有（HS6509，另有同题的 HS3743），
 * 所以新入库 19 道，第 4 天直接复用 HS6509，20 天里没有重复题。
 */
const start = '2026-11-26';
const codes = [
    'HS7542',  // (1)  tan x /(3sin²x+2cos²x)
    'HS7543',  // (2)  (x²+1)/(x√(x⁴+1))
    'HS7544',  // (3)  1/(x²√(1+x²))
    'HS6509',  // (4)  ln x/(x√(1+ln x))　—— 库内已有
    'HS7545',  // (5)  arctan√x
    'HS7546',  // (6)  x tan x sec⁴x
    'HS7547',  // (7)  x e^x/√(e^x−2)
    'HS7548',  // (8)  (x²+20)/(x sinx+5cosx)²
    'HS7549',  // (9)  (x+1)/√(x−x²)
    'HS7550',  // (10) e^x(1+sinx)/(1+cosx)
    'HS7551',  // (11) ln(1+e^−x)/(1+e^x)
    'HS7552',  // (12) 1/(sin2x+2sinx)
    'HS7553',  // (13) 1/(1+e^x)²
    'HS7554',  // (14) e^{arctanx}/(1+x²)^{3/2}
    'HS7555',  // (15) 1/(sinx cos³x)
    'HS7556',  // (16) √x/(1+√(1+x))
    'HS7557',  // (17) 1/((2x−1)√(x−x²))
    'HS7558',  // (18) x⁴/(x⁴+5x²+4)
    'HS7559',  // (19) (cosx+x sinx)/(x+cosx)²
    'HS7560'   // (20) (1+x²)arcsinx/(x²√(1−x²))
  ]

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
  return i >= 0 && i < codes.length ? i : -1;
}

module.exports = { start, codes, indexFor };
