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

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
for (const f of [JSON_FILE, SQLITE_FILE, SQLITE_FILE + '-wal', SQLITE_FILE + '-shm']) {
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
}
try { fs.rmdirSync(TMP); } catch (e) {}
process.exit(fail ? 1 : 0);
