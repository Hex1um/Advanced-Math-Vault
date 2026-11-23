/**
 * 用 AI 复核并修复待审考研题的「题干 ↔ 解析」配对。
 *
 * 背景：这批题来自 PDF 转写，真题与解析的编号规则不一致，导致解析错位。
 * 做法：把同一年的整份卷子（题干列表 + 解析池）交给模型，让它按语义重新配对。
 *       比逐题判断可靠——因为模型能看到「这一年的解析池整体长什么样」。
 *
 * 用法：
 *   node tools/repair-kaoyan.mjs --dry            # 只报预览
 *   node tools/repair-kaoyan.mjs --apply          # 写库（修复的转为 approved）
 *   node tools/repair-kaoyan.mjs --apply --limit 3
 */
import fs from 'node:fs';

const DB = 'data/db.json';
const APPLY = process.argv.includes('--apply');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 0);
const KEY = process.env.DEEPSEEK_API_KEY || '';
const BASE = process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1';
const MODEL = process.env.LLM_MODEL || 'deepseek-chat';

if (!KEY) {
  console.error('缺少 DEEPSEEK_API_KEY，无法调用模型');
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(DB, 'utf8'));

/* 按年份分组：同一年一起处理，模型才能看到整卷语义 */
const byYear = {};
for (const p of db.problems) {
  if (!/硕士研究生招生考试/.test(p.source || '')) continue;
  const y = p.source.slice(0, 4);
  (byYear[y] = byYear[y] || []).push(p);
}

async function call(messages, timeoutMs = 180000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: MODEL, messages, temperature: 0.1, stream: false }),
      signal: ctl.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  } finally {
    clearTimeout(timer);
  }
}

/* 从模型输出里抠 JSON 数组 */
function extractJson(text) {
  const m = String(text).match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

const SYS = [
  '你是考研数学题库的校对员。给你某一年的真题列表和解析池，请把解析重新按语义配给正确的题目。',
  '',
  '规则：',
  '1. 只按数学内容判断，不要按编号顺序硬凑；',
  '2. 解析池里的条目会给出序号和内容摘要；',
  '3. 对每道题，判断解析池里哪一条真正是它的解答；找不到就填 null；',
  '4. 如果题目本身的答案（选择题的 ABCD、填空题的数值）也能从解析里得到，一并给出；',
  '5. 不确定就填 null——错配比缺失危害大得多。',
  '',
  '输出严格的 JSON 数组，不要代码块、不要解释：',
  '[{"idx": 题目序号, "sol": 解析池序号或null, "answer": "答案或空串", "confidence": "high|low"}]'
].join('\n');

const stats = { years: 0, fixed: 0, dropped: 0, failed: 0 };
const years = Object.keys(byYear).sort();
let processed = 0;

for (const y of years) {
  if (LIMIT && processed >= LIMIT) break;
  const probs = byYear[y];
  const pending = probs.filter((p) => p.status === 'pending');
  if (!pending.length) continue;
  processed++;
  stats.years++;

  // 解析池：把这一年的所有解析都放进去（包括已配好的），让模型有完整视野
  const pool = [];
  const usedSol = new Set();
  probs.forEach((p) => {
    const s = (p.solution || '').trim();
    if (s && !usedSol.has(s)) { usedSol.add(s); pool.push({ code: p.code, text: s }); }
  });
  if (!pool.length) {
    console.log(y, '：没有可用解析，跳过');
    continue;
  }

  const payload = {
    year: y,
    problems: pending.map((p, i) => ({
      idx: i, code: p.code, kind: /选择题/.test(p.title) ? 'choice' : /填空题/.test(p.title) ? 'fill' : 'solution',
      stem: String(p.statement).slice(0, 500)
    })),
    solutions: pool.map((s, i) => ({ idx: i, excerpt: s.text.replace(/\s+/g, ' ').slice(0, 260) }))
  };

  process.stdout.write(`${y}：${pending.length} 题待审，解析池 ${pool.length} 条 … `);
  let out = '';
  try {
    out = await call([
      { role: 'system', content: SYS },
      { role: 'user', content: JSON.stringify(payload) }
    ]);
  } catch (e) {
    console.log('调用失败', e.message);
    stats.failed++;
    continue;
  }

  const arr = extractJson(out);
  if (!Array.isArray(arr)) { console.log('输出不是 JSON，跳过'); stats.failed++; continue; }

  let fx = 0;
  for (const item of arr) {
    const p = pending[item.idx];
    if (!p) continue;
    if (item.sol === null || item.sol === undefined) {
      // 明确说配不上：保留题干，清掉错误解析，继续待审
      p.solution = '';
      p.answer = '';
      stats.dropped++;
      continue;
    }
    const src = pool[item.sol];
    if (!src) continue;
    const same = (p.solution || '').trim() === src.text.trim();
    if (!same) {
      p.solution = src.text;
      stats.fixed++;
      fx++;
    }
    if (item.answer && String(item.answer).trim()) p.answer = String(item.answer).trim();
    if (item.confidence === 'high') p.status = 'approved';
    p.repairNote = 'AI 重配 ' + new Date().toISOString().slice(0, 10) + ' · ' + (item.confidence || 'low');
  }
  console.log(`修 ${fx} 条`);
}

console.log('\n年度处理', stats.years, '｜重配', stats.fixed, '｜判为无法配对', stats.dropped, '｜失败', stats.failed);

if (APPLY) {
  fs.writeFileSync(DB, JSON.stringify(db, null, 2), 'utf8');
  const st = {};
  for (const p of db.problems) st[p.status] = (st[p.status] || 0) + 1;
  console.log('已写库：', st);
} else {
  console.log('（预览模式，未写库。加 --apply 生效）');
}
