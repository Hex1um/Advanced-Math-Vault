#!/usr/bin/env node
/**
 * 两件事：
 *  1) 待审题复审：有解析的留着；没有解析的先看是否与已上线题重复（重复即驳回），
 *     否则按「缺少解析」驳回。
 *  2) 证明题难度重评：证明类题普遍被高估，按规则整体下调。
 *
 *   node tools/archive/fix-pending-and-proof.mjs          # 只报告
 *   node tools/archive/fix-pending-and-proof.mjs --apply  # 写库
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const APPLY = process.argv.includes('--apply');
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/\\(?:mathrm|operatorname|text|displaystyle|dfrac|tfrac|left|right|quad|qquad)\b\s*/g, '')
  .replace(/\\([a-zA-Z]+)/g, '$1')
  .replace(/[{}\[\]$^_~\\\s，。；、,.;:：！!？?（）()「」"'\u2018\u2019\u201c\u201d\-—·]/g, '');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v))));

/* ---------- 1. 待审题复审 ---------- */
const approvedKeys = new Map();
for (const p of db.problems) {
  if (p.status !== 'approved') continue;
  const k = norm(p.statement);
  if (k) approvedKeys.set(k, p);
}

const pending = db.problems.filter((p) => p.status === 'pending');
const rejected = { dup: [], noSol: [] };
const kept = [];
for (const p of pending) {
  const hasSol = String(p.solution || '').trim().length >= 10;
  if (hasSol) { kept.push(p); continue; }
  const same = approvedKeys.get(norm(p.statement));
  if (same) { rejected.dup.push([p.code, same.code]); continue; }
  rejected.noSol.push(p.code);
}

console.log(`待审 ${pending.length}：留着 ${kept.length}，重复驳回 ${rejected.dup.length}，缺解析驳回 ${rejected.noSol.length}`);
if (rejected.dup.length) console.log('  重复样例:', rejected.dup.slice(0, 5).map(([a, b]) => a + '=' + b).join(', '));
if (rejected.noSol.length) console.log('  缺解析样例:', rejected.noSol.slice(0, 8).join(', '));

/* ---------- 2. 证明题难度重评 ---------- */
const isProof = (p) => {
  const t = (p.title || '') + ' ' + String(p.statement || '').slice(0, 80);
  return /证明|求证|试证|证：/.test(t);
};

const changes = [];
for (const p of db.problems) {
  if (p.proofRescored) continue;
  if (p.status !== 'approved') continue;
  if (!isProof(p)) continue;
  const short = String(p.statement || '').length < 160;
  const diff = p.difficulty || 6;
  const think = p.thinking || 6;
  const calc = p.calc || 5;
  // 证明题：难度/思维量下调，计算量本来就低，不再往下砍，只做上限收敛
  const nextDiff = diff >= 8 ? diff - 3 : diff >= 6 ? diff - (short ? 2 : 1) : diff;
  const nextThink = think >= 8 ? think - 2 : think >= 5 ? think - 1 : think;
  const next = {
    difficulty: clamp(nextDiff, 3, 10),
    thinking: clamp(nextThink, 3, 10),
    calc: clamp(Math.min(calc, 5), 2, 10)
  };
  if (next.difficulty !== p.difficulty || next.thinking !== p.thinking || next.calc !== p.calc) {
    changes.push({ code: p.code, from: [p.thinking, p.difficulty, p.calc], to: [next.thinking, next.difficulty, next.calc], short });
  }
}

const proofCount = db.problems.filter((p) => p.status === 'approved' && isProof(p)).length;
console.log(`证明类上线题 ${proofCount}，需要下调 ${changes.length}`);
if (changes.length) {
  const avg = changes.reduce((s, c) => s + (c.from[1] - c.to[1]), 0) / changes.length;
  console.log(`  难度平均下调 ${avg.toFixed(1)} 分，样例:`,
    changes.slice(0, 5).map((c) => `${c.code} ${c.from.join('/')}→${c.to.join('/')}`).join(' | '));
}

if (APPLY) {
  const bak = DB_FILE + '.before-fix-' + Date.now() + '.json';
  fs.copyFileSync(DB_FILE, bak);
  for (const p of pending) {
    if (String(p.solution || '').trim().length >= 10) continue;
    const same = approvedKeys.get(norm(p.statement));
    p.status = 'rejected';
    p.rejectReason = same ? `与已上线题 ${same.code} 重复` : '缺少解析，暂不入库';
    p.reviewedAt = new Date().toISOString();
  }
  const byCode = new Map(db.problems.map((p) => [p.code, p]));
  for (const c of changes) {
    const p = byCode.get(c.code);
    if (!p) continue;
    p.thinking = c.to[0];
    p.difficulty = c.to[1];
    p.calc = c.to[2];
    p.proofRescored = true;
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  console.log('已写盘 | 备份', path.basename(bak));
  const st = {};
  for (const p of db.problems) st[p.status] = (st[p.status] || 0) + 1;
  console.log('现在:', st);
}
