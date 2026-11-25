#!/usr/bin/env node
/**
 * 存储层自测：SQLite 引擎的导入 / 增量落盘 / 重载一致性
 *
 *   node tools/verify/store-test.mjs
 *
 * 覆盖的是「Proxy 变更追踪」这套最容易出错的地方：
 * 改字段、push 新行、改嵌套数组、改嵌套对象、改映射表（sessions/emailCodes）、
 * 整体重新赋值数组、改 kv（settings/meta），每种都写盘后重新打开库比对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const { createStore } = require(path.join(ROOT, 'lib', 'store.js'));

const TMP = path.join(ROOT, 'data', '.store-test');
const JSON_FILE = path.join(TMP, 'db.json');
const SQLITE_FILE = path.join(TMP, 'db.sqlite');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

for (const f of [JSON_FILE, JSON_FILE + '.tmp', SQLITE_FILE, SQLITE_FILE + '-wal', SQLITE_FILE + '-shm']) {
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
}
fs.mkdirSync(TMP, { recursive: true });

const future = Date.now() + 86400000;
const fixture = {
  users: [{ id: 'u1', name: ' tester ', email: '', salt: 's', passHash: 'h', exp: 10, solved: { HS1: { done: true, at: 1 } }, best: {}, wrong: {} }],
  problems: [
    { code: 'HS1', title: '题一', statement: '求 $\\lim x$', mainTag: '极限与连续', tags: ['函数极限'], difficulty: 4, status: 'approved', hints: ['a'], scoreSum: 0, scoreCount: 0 },
    { code: 'HS2', title: '题二', statement: '求导', mainTag: '导数与微分', tags: ['求导法则'], difficulty: 6, status: 'approved', hints: [], scoreSum: 0, scoreCount: 0 },
    { code: 'HS3', title: '题三', statement: '积分', mainTag: '积分', tags: ['定积分'], difficulty: 7, status: 'pending', hints: [], scoreSum: 0, scoreCount: 0 }
  ],
  posts: [{ id: 1, authorId: 'u1', authorName: 'tester', title: '首帖', body: '正文', problemCode: 'HS1', replies: [{ id: 1, authorName: 'AI 助教', body: '答复', isAI: true }], createdAt: '2026-01-01T00:00:00Z' }],
  submissions: [{ id: 's1', uid: 'u1', code: 'HS1', score: 90, at: 1735689600000 }],
  feedbacks: [{ id: 1, code: 'HS1', type: 'other', content: '题干有误', status: 'open', createdAt: '2026-01-02T00:00:00Z' }],
  sessions: { live: { uid: 'u1', exp: future }, dead: { uid: 'u1', exp: Date.now() - 1000 } },
  daily: { '2026-01-01': { code: 'HS1' } },
  emailCodes: { u1: { email: 'a@b.com', code: '123456', exp: future } },
  settings: { llm: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '' }, site: '数海晴岸' },
  meta: { seq: 1004, postSeq: 2, replySeq: 2, feedbackSeq: 2 }
};

fs.writeFileSync(JSON_FILE, JSON.stringify(fixture, null, 2), 'utf8');

const store = createStore({ engine: 'sqlite', dbFile: JSON_FILE, mirrorJson: false, log: () => {} });

console.log('\n[1] 全量导入与校验');
store.open();
store.importAll(fixture);
const v1 = store.verify(fixture);
ok('导入后逐行一致', v1.ok, v1.problems.join('; '));
const loaded = store.load();
ok('重载题目数一致', loaded.problems.length === 3);
ok('重载帖子嵌套回复保留', loaded.posts[0].replies.length === 1);
ok('过期会话不重载', !loaded.sessions.dead && !!loaded.sessions.live);
ok('kv(settings) 重载', loaded.settings.llm.model === 'deepseek-chat');
ok('kv(meta) 重载', loaded.meta.seq === 1004);

console.log('\n[2] 通过 Proxy 做增量修改');
let db = store.attach(loaded);
db.problems[0].title = '题一（改名）';
db.problems.push({ code: 'HS4', title: '题四', statement: '新增', mainTag: '级数', tags: ['幂级数'], difficulty: 5, status: 'approved' });
db.posts[0].replies.push({ id: 2, authorName: 'tester', body: '追问' });
db.users[0].best['HS1'] = { score: 100, at: 2 };
db.sessions.tok2 = { uid: 'u1', exp: future };
delete db.sessions.live;
db.daily['2026-01-02'] = { code: 'HS2' };
db.settings.llm.model = 'deepseek-reasoner';
db.meta.seq = 2000;
db.feedbacks[0].status = 'closed';
const r1 = store.save(db);
ok('保存只写变化行（不整表重写）', r1.wrote > 0 && r1.wrote < 12, 'wrote=' + r1.wrote);

let re = store.load();
ok('字段修改已落盘', re.problems[0].title === '题一（改名）');
ok('push 的新题已落盘', re.problems.length === 4 && re.problems[3].code === 'HS4');
ok('嵌套数组新增已落盘', re.posts[0].replies.length === 2);
ok('嵌套对象新增已落盘', !!(re.users[0].best && re.users[0].best.HS1));
ok('映射新增已落盘', !!re.sessions.tok2);
ok('映射删除已落盘', !re.sessions.live);
ok('daily 新增已落盘', !!re.daily['2026-01-02']);
ok('settings 修改已落盘', re.settings.llm.model === 'deepseek-reasoner');
ok('meta 修改已落盘', re.meta.seq === 2000);
ok('feedback 状态已落盘', re.feedbacks[0].status === 'closed');

console.log('\n[3] 整体重新赋值与删除');
db = store.attach(re);
db.posts = db.posts.filter((p) => p.id !== 1);
db.submissions = [];
store.save(db);
re = store.load();
ok('整体重新赋值后行数正确', re.posts.length === 0 && re.submissions.length === 0);

console.log('\n[4] 行数对账与关闭');
store.reconcile(re);
const stats = store.stats();
ok('对账后行数与内容一致', stats.counts.problems === 4 && stats.counts.posts === 0, JSON.stringify(stats.counts));
store.close(re);
ok('关闭后 sqlite 文件存在', fs.existsSync(SQLITE_FILE));

/* ---------------------------------------------------------- P0-2 专项回归
   1) 改 map 条目字段（db.sessions[tok].exp）要能落盘——旧实现把 key 丢了，
      记成 markDirty('sessions','exp')，SQLite 增量落盘静默丢写。
   2) push 一条新数据不该整表重建（wrote 必须等于 1，不是 6400+）。
   3) 表里有过期会话时，连续保存不能每次对账都误触发全库重建。
   4) 嵌套数组（hints）内元素的增删要能落盘。 */
console.log('\n[5] P0-2 回归：Map 主键 / 精确增删 / 对账口径');
const TMP2 = path.join(ROOT, 'data', '.store-test2');
const JSON2 = path.join(TMP2, 'db.json');
const SQLITE2 = path.join(TMP2, 'db.sqlite');
for (const f of [JSON2, JSON2 + '.tmp', SQLITE2, SQLITE2 + '-wal', SQLITE2 + '-shm']) {
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
}
fs.mkdirSync(TMP2, { recursive: true });
const logs = [];
const store2 = createStore({ engine: 'sqlite', dbFile: JSON2, mirrorJson: false, reconcileEvery: 5, log: (m) => logs.push(String(m)) });
store2.open();
store2.importAll(JSON.parse(JSON.stringify(fixture)));
let d2 = store2.attach(store2.load());

// 1) map 条目字段：key 不能丢
const newExp = future + 3600000;
d2.sessions.live.exp = newExp;
let r2 = store2.save(d2);
ok('改 map 条目字段只写 1 行', r2.wrote === 1, 'wrote=' + r2.wrote);
let re2 = store2.load();
ok('sessions[token].exp 已落盘', !!(re2.sessions.live && re2.sessions.live.exp === newExp), JSON.stringify(re2.sessions.live));

// 2) push 一条新题：只 UPSERT 那一行
d2.problems.push({ code: 'HS9', title: '题九', statement: '新增', mainTag: '级数', tags: ['幂级数'], difficulty: 5, status: 'approved', hints: [] });
r2 = store2.save(d2);
ok('push 只写新增的 1 行（无整表重建）', r2.wrote === 1, 'wrote=' + r2.wrote);
ok('push 后新题可重载', store2.load().problems.some((p) => p.code === 'HS9'));

// 3) splice 删除一条：只 DELETE 那一行
d2.feedbacks.splice(0, 1);
r2 = store2.save(d2);
ok('splice 删除只动 1 行', r2.wrote === 1, 'wrote=' + r2.wrote);
ok('删除已生效', store2.load().feedbacks.length === 0);

// 4) 含过期会话时连续保存，不触发全库重建
d2.sessions.stale = { uid: 'u1', exp: Date.now() - 1000 };
store2.save(d2);
logs.length = 0;
for (let i = 0; i < 25; i++) store2.save(d2);
ok('25 次保存不误触发整库重建', !logs.some((m) => /整表重建|行数对不上/.test(m)), logs.join(' | '));
ok('过期会话已被清理', !store2.load().sessions.stale);

// 5) 嵌套数组元素增删
const row1 = d2.problems.find((p) => p.code === 'HS1');
row1.hints.push('b');
store2.save(d2);
ok('hints 新增已落盘', JSON.stringify(store2.load().problems.find((p) => p.code === 'HS1').hints) === '["a","b"]');
d2.problems.find((p) => p.code === 'HS1').hints.splice(0, 1);
store2.save(d2);
ok('hints 删除已落盘', JSON.stringify(store2.load().problems.find((p) => p.code === 'HS1').hints) === '["b"]');

// 6) 直接按索引删除元素（delete arr[i]）
delete d2.problems[0];
r2 = store2.save(d2);
ok('delete arr[i] 精确删行', r2.wrote === 1, 'wrote=' + r2.wrote);
ok('delete arr[i] 已生效', !store2.load().problems.some((p) => p.code === 'HS1'));

store2.close(store2.load());
for (const f of [JSON2, SQLITE2, SQLITE2 + '-wal', SQLITE2 + '-shm']) {
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
}
try { fs.rmdirSync(TMP2); } catch (e) {}

/* ---------------------------------------------------- P2-3 搜索索引等价性
   索引只负责把候选缩小，最终仍由同一套内存谓词判定。
   这里用真实题库数据逐条比对：索引候选必须是内存结果的超集，
   且「索引候选 ∩ 谓词」与「全量 ∩ 谓词」完全一致。 */
console.log('\n[6] P2-3 搜索索引：与内存过滤逐条等价');
const TMP3 = path.join(ROOT, 'data', '.store-test3');
const JSON3 = path.join(TMP3, 'db.json');
const SQLITE3 = path.join(TMP3, 'db.sqlite');
for (const f of [JSON3, SQLITE3, SQLITE3 + '-wal', SQLITE3 + '-shm']) {
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
}
fs.mkdirSync(TMP3, { recursive: true });
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'batch-01.json'), 'utf8'))
  .map((p, i) => Object.assign({}, p, { code: (p.code || 'S' + i), status: 'approved', tags: p.tags || [] }));
const fixture3 = {
  problems: corpus, users: [], posts: [], submissions: [], feedbacks: [],
  sessions: {}, daily: {}, emailCodes: {}, settings: {}, meta: { seq: corpus.length + 1 }
};
fs.writeFileSync(JSON3, JSON.stringify(fixture3, null, 2));
const store3 = createStore({ engine: 'sqlite', dbFile: JSON3, mirrorJson: false, log: () => {} });
store3.open();
store3.importAll(fixture3);

const matchQ = (p, q) =>
  p.title.toLowerCase().includes(q) ||
  p.code.toLowerCase().includes(q) ||
  String(p.mainTag || '').toLowerCase().includes(q) ||
  (p.examTags || []).some((t) => t.toLowerCase().includes(q)) ||
  (p.tags || []).some((t) => t.toLowerCase().includes(q)) ||
  String(p.source || '').toLowerCase().includes(q);

const queries = ['积分', '定积', 'arcsin', '求', 'sin', 'ln', 'x^2', '根号', '分部', '指数', '不存在的关键词zzz', '洛必达'];
let parityBad = 0;
for (const q of queries) {
  const term = q.toLowerCase();
  const mem = corpus.filter((p) => matchQ(p, term)).map((p) => p.code).sort();
  const idx = store3.searchProblemCodes(q);
  if (!idx) { ok('索引对「' + q + '」可用', false, '返回 null'); parityBad++; continue; }
  const missing = mem.filter((c) => !idx.has(c));
  const viaIdx = corpus.filter((p) => idx.has(p.code) && matchQ(p, term)).map((p) => p.code).sort();
  const same = JSON.stringify(viaIdx) === JSON.stringify(mem);
  ok('「' + q + '」索引结果与内存一致（' + mem.length + ' 条）', !missing.length && same,
    '缺少 ' + missing.slice(0, 3).join(',') + ' / 结果不一致');
  if (missing.length || !same) parityBad++;
}
ok('索引查询整体等价', parityBad === 0, parityBad + ' 条不一致');

// 增量维护：改题、删题后索引必须跟着变
let db3 = store3.attach(store3.load());
const target = db3.problems.find((p) => p.code === corpus[0].code);
target.title = '新标题：傅里叶级数收敛判别';
store3.save(db3);
ok('改题后新关键词可命中', (store3.searchProblemCodes('傅里叶') || new Set()).has(corpus[0].code));
ok('改题后旧关键词不再误命中',
  !(store3.searchProblemCodes(String(corpus[0].title || 'zzz').toLowerCase().slice(0, 6)) || new Set()).has(corpus[0].code)
  || String(corpus[0].title || '').slice(0, 6) === '新标题：傅');

db3.problems.splice(0, 1);
store3.save(db3);
ok('删题后从索引移除', !(store3.searchProblemCodes('傅里叶') || new Set()).has(corpus[0].code));

store3.close(store3.load());
for (const f of [JSON3, SQLITE3, SQLITE3 + '-wal', SQLITE3 + '-shm']) {
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
}
try { fs.rmdirSync(TMP3); } catch (e) {}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
for (const f of [JSON_FILE, SQLITE_FILE, SQLITE_FILE + '-wal', SQLITE_FILE + '-shm']) {
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
}
try { fs.rmdirSync(TMP); } catch (e) {}
process.exit(fail ? 1 : 0);
