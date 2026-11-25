/**
 * 存储层：JSON（默认，历史行为）与 SQLite（可选，行级增量落盘）
 *
 * 为什么要有这一层：库到 6000+ 题、用户/提交/帖子持续增长后，每次保存都要
 * JSON.stringify 整个库再 fsync，全量序列化会阻塞 Node 单线程事件循环；
 * 而且单文件 JSON 也没法做「多实例共用一个库」。
 *
 * 本模块只做持久化，不改业务语义：
 *   - JSON 引擎：完全沿用 server.js 原来的「全量原子写」，unused 路径零风险。
 *   - SQLite 引擎：内存里仍是同一个 db 对象，但用 Proxy 记录「哪条被改了」，
 *     保存时只 UPSERT 变化的行；结构性变化（导入/删除）才重建该表。
 *     同时按 DB_MIRROR_JSON 的节奏导出 db.json，保证 sync-live / deploy /
 *     robustness-check 这些按 db.json 工作的老工具继续可用。
 *
 * 表结构是「索引列 + body(JSON)」混合：常用查询条件单独成列建索引，
 * 嵌套结构（提示、回复、做题记录）整体放 body，避免把业务对象拆散后
 * 再拼不回来。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

/* 集合型（数组）数据：key 用于行主键，extra 抽成索引列 */
const COLLECTIONS = {
  problems: {
    table: 'problems',
    key: (r) => r && r.code,
    extra: (r) => ({
      status: String(r.status || ''),
      main_tag: String(r.mainTag || ''),
      sub_tag: String((Array.isArray(r.tags) && r.tags[0]) || ''),
      difficulty: Number(r.difficulty) || 0
    })
  },
  users: {
    table: 'users',
    key: (r) => r && r.id,
    extra: (r) => ({ name: String(r.name || ''), email: String(r.email || '') })
  },
  posts: {
    table: 'posts',
    key: (r) => r && r.id,
    extra: (r) => ({
      author_id: String(r.authorId === null || r.authorId === undefined ? '' : r.authorId),
      problem_code: String(r.problemCode || ''),
      created_at: String(r.createdAt || '')
    })
  },
  submissions: {
    table: 'submissions',
    key: (r) => r && r.id,
    extra: (r) => ({
      user_id: String(r.userId === undefined ? (r.uid === undefined ? '' : r.uid) : r.userId),
      problem_code: String(r.code || r.problemCode || ''),
      score: Number(r.score) || 0,
      created_at: String(r.at || r.createdAt || '')
    })
  },
  feedbacks: {
    table: 'feedbacks',
    key: (r) => r && r.id,
    extra: (r) => ({
      code: String(r.code || ''),
      status: String(r.status || 'open'),
      created_at: String(r.createdAt || '')
    })
  }
};

/* 映射型（对象）数据 */
const MAP_COL_TYPES = { uid: 'TEXT', exp: 'INTEGER' };
const MAPS = {
  sessions: { table: 'sessions', cols: ['uid', 'exp'], extra: (v) => ({ uid: String(v && v.uid), exp: Number(v && v.exp) || 0 }) },
  daily: { table: 'daily', cols: [], extra: () => ({}) },
  emailCodes: { table: 'email_codes', cols: ['exp'], extra: (v) => ({ exp: Number(v && v.exp) || 0 }) }
};

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, body TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS problems (k TEXT PRIMARY KEY, status TEXT, main_tag TEXT, sub_tag TEXT, difficulty INTEGER, body TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_problems_tag ON problems(status, main_tag, difficulty)',
  'CREATE INDEX IF NOT EXISTS idx_problems_sub ON problems(sub_tag)',
  'CREATE TABLE IF NOT EXISTS users (k TEXT PRIMARY KEY, name TEXT, email TEXT, body TEXT NOT NULL)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name ON users(name COLLATE NOCASE)',
  'CREATE TABLE IF NOT EXISTS posts (k TEXT PRIMARY KEY, author_id TEXT, problem_code TEXT, created_at TEXT, body TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_posts_problem ON posts(problem_code)',
  'CREATE TABLE IF NOT EXISTS submissions (k TEXT PRIMARY KEY, user_id TEXT, problem_code TEXT, score REAL, created_at TEXT, body TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_sub_user ON submissions(user_id, problem_code)',
  'CREATE TABLE IF NOT EXISTS feedbacks (k TEXT PRIMARY KEY, code TEXT, status TEXT, created_at TEXT, body TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_fb_status ON feedbacks(status)',
  'CREATE TABLE IF NOT EXISTS daily (k TEXT PRIMARY KEY, body TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS sessions (k TEXT PRIMARY KEY, uid TEXT, exp INTEGER, body TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(exp)',
  'CREATE TABLE IF NOT EXISTS email_codes (k TEXT PRIMARY KEY, exp INTEGER, body TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)'
];

function mapCreateSql(kind) {
  const def = MAPS[kind];
  return 'CREATE TABLE IF NOT EXISTS ' + def.table + ' (k TEXT PRIMARY KEY'
    + def.cols.map((c) => ', ' + c + ' ' + (MAP_COL_TYPES[c] || 'TEXT')).join('') + ', body TEXT NOT NULL)';
}

function mapUpsertSql(kind) {
  const def = MAPS[kind];
  const all = ['k'].concat(def.cols, ['body']);
  return 'INSERT INTO ' + def.table + '(' + all.join(',') + ') VALUES('
    + all.map(() => '?').join(',') + ') ON CONFLICT(k) DO UPDATE SET '
    + def.cols.concat(['body']).map((c) => c + '=excluded.' + c).join(', ');
}

function collectionExtraKeys(kind) {
  return { problems: ['status', 'main_tag', 'sub_tag', 'difficulty'], users: ['name', 'email'], posts: ['author_id', 'problem_code', 'created_at'], submissions: ['user_id', 'problem_code', 'score', 'created_at'], feedbacks: ['code', 'status', 'created_at'] }[kind];
}

function upsertSql(kind) {
  const cols = collectionExtraKeys(kind);
  const all = ['k'].concat(cols, ['body']);
  return 'INSERT INTO ' + COLLECTIONS[kind].table + '(' + all.join(',') + ') VALUES('
    + all.map(() => '?').join(',') + ') ON CONFLICT(k) DO UPDATE SET '
    + cols.concat(['body']).map((c) => c + '=excluded.' + c).join(', ');
}

function resolveEngine(requested) {
  const want = String(requested || process.env.DB_ENGINE || 'json').toLowerCase();
  if (want === 'sqlite' || want === 'json') return want;
  return 'json';
}

function createStore(options) {
  const opts = options || {};
  const log = opts.log || ((...a) => console.log(...a));
  const engine = resolveEngine(opts.engine);
  const dbPath = opts.dbFile || path.join(opts.dataDir || 'data', 'db.json');
  const sqliteFile = opts.sqliteFile || dbPath.replace(/\.json$/i, '') + '.sqlite';
  const mirrorJson = opts.mirrorJson !== undefined
    ? !!opts.mirrorJson
    : String(process.env.DB_MIRROR_JSON === undefined ? '1' : process.env.DB_MIRROR_JSON) !== '0';
  const mirrorInterval = Number(opts.mirrorIntervalMs || process.env.DB_MIRROR_INTERVAL_MS || 300000);
  const reconcileEvery = Number(opts.reconcileEvery || process.env.DB_RECONCILE_EVERY || 50);

  let sqlite = null;
  let ready = false;
  let stmts = null;

  /* ---- 变更追踪 ---- */
  const proxies = new WeakMap();   // raw → proxy
  const proxySet = new WeakSet();  // 已代理对象（避免重复包裹）
  const dirty = new Map();         // kind → Set(key)
  const structural = new Set();    // 需要整表重建的 kind
  const kvDirty = new Set();       // 'settings' | 'meta'
  let lastMirrorAt = 0;
  let flushCount = 0;
  let lastFlushMs = 0;
  let attached = null;

  function markDirty(kind, key) {
    if (key === undefined || key === null || key === '') { structural.add(kind); return; }
    let s = dirty.get(kind);
    if (!s) { s = new Set(); dirty.set(kind, s); }
    s.add(String(key));
  }

  function keyOf(kind, row) {
    const def = COLLECTIONS[kind];
    const k = def && row ? def.key(row) : undefined;
    return k === undefined || k === null ? '' : String(k);
  }

  /* ctx 说明当前代理位于哪里：
     { collection: kind } 集合数组；{ row: {kind, target} } 某一行（含嵌套）；
     { map: kind } 映射对象；{ root: true } 库根对象 */
  function wrap(value, ctx) {
    if (!value || typeof value !== 'object') return value;
    if (proxySet.has(value)) return value;
    const cached = proxies.get(value);
    if (cached) return cached;
    const handler = Array.isArray(value) ? arrayHandler(ctx) : objectHandler(ctx, value);
    const p = new Proxy(value, handler);
    proxies.set(value, p);
    proxySet.add(p);
    return p;
  }

  function markHit(ctx, prop) {
    if (!ctx) return;
    if (ctx.root) {
      if (prop === 'settings' || prop === 'meta') kvDirty.add(prop);
      else if (COLLECTIONS[prop]) structural.add(prop);
      else if (MAPS[prop]) structural.add(prop);
      return;
    }
    if (ctx.collection) { structural.add(ctx.collection); return; }
    if (ctx.row) { markDirty(ctx.row.kind, keyOf(ctx.row.kind, ctx.row.target)); return; }
    if (ctx.map) { markDirty(ctx.map, prop); }
  }

  function arrayHandler(parentCtx) {
    return {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof prop === 'symbol' || prop === 'length') return v;
        if (v && typeof v === 'object') {
          if (parentCtx && parentCtx.collection) {
            return wrap(v, { row: { kind: parentCtx.collection, target: v } });
          }
          return wrap(v, parentCtx);
        }
        return v;
      },
      set(target, prop, value, receiver) {
        const before = target.length;
        const ok = Reflect.set(target, prop, value, receiver);
        if (parentCtx && parentCtx.collection) {
          if (prop === 'length') {
            if (target.length !== before) structural.add(parentCtx.collection);
          } else if (/^\d+$/.test(String(prop))) {
            if (Number(prop) >= before) structural.add(parentCtx.collection);
            else markDirty(parentCtx.collection, keyOf(parentCtx.collection, value));
          }
        } else if (parentCtx && parentCtx.row) {
          markDirty(parentCtx.row.kind, keyOf(parentCtx.row.kind, parentCtx.row.target));
        } else if (parentCtx && parentCtx.kv) {
          kvDirty.add(parentCtx.kv);
        } else if (parentCtx && parentCtx.map) {
          markDirty(parentCtx.map, prop);
        }
        return ok;
      },
      deleteProperty(target, prop) {
        const ok = Reflect.deleteProperty(target, prop);
        if (parentCtx && parentCtx.collection) structural.add(parentCtx.collection);
        else if (parentCtx && parentCtx.kv) kvDirty.add(parentCtx.kv);
        return ok;
      }
    };
  }

  function objectHandler(parentCtx, target) {
    return {
      get(obj, prop, receiver) {
        const v = Reflect.get(obj, prop, receiver);
        if (typeof prop === 'symbol') return v;
        if (v && typeof v === 'object') {
          if (parentCtx && parentCtx.root) {
            if (COLLECTIONS[prop]) return wrap(v, { collection: prop });
            if (MAPS[prop]) return wrap(v, { map: prop });
            if (prop === 'settings' || prop === 'meta') return wrap(v, { kv: prop });
            return wrap(v, parentCtx);
          }
          if (parentCtx && parentCtx.kv) return wrap(v, { kv: parentCtx.kv });
          if (parentCtx && parentCtx.map) return wrap(v, { map: parentCtx.map });
          if (parentCtx && parentCtx.row) return wrap(v, parentCtx);
          return wrap(v, parentCtx);
        }
        return v;
      },
      set(obj, prop, value, receiver) {
        const ok = Reflect.set(obj, prop, value, receiver);
        if (parentCtx && parentCtx.root) {
          if (COLLECTIONS[prop] || MAPS[prop]) { structural.add(prop); dirty.delete(prop); }
          else if (prop === 'settings' || prop === 'meta') kvDirty.add(prop);
        } else if (parentCtx && parentCtx.map) {
          markDirty(parentCtx.map, prop);
        } else if (parentCtx && parentCtx.kv) {
          kvDirty.add(parentCtx.kv);
        } else if (parentCtx && parentCtx.row) {
          markDirty(parentCtx.row.kind, keyOf(parentCtx.row.kind, parentCtx.row.target));
        } else if (parentCtx && parentCtx.collection) {
          structural.add(parentCtx.collection);
        }
        return ok;
      },
      deleteProperty(obj, prop) {
        const ok = Reflect.deleteProperty(obj, prop);
        if (parentCtx && parentCtx.map) markDirty(parentCtx.map, prop);
        else if (parentCtx && parentCtx.kv) kvDirty.add(parentCtx.kv);
        else if (parentCtx && parentCtx.row) markDirty(parentCtx.row.kind, keyOf(parentCtx.row.kind, parentCtx.row.target));
        else if (parentCtx && parentCtx.root && (COLLECTIONS[prop] || MAPS[prop])) structural.add(prop);
        return ok;
      }
    };
  }

  /* ---- SQLite ---- */
  function open() {
    if (engine !== 'sqlite') return false;
    if (sqlite) return true;
    let DatabaseSync;
    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } catch (e) {
      throw new Error('当前 Node 没有内置 node:sqlite（需要 22.5+），无法启用 DB_ENGINE=sqlite');
    }
    fs.mkdirSync(path.dirname(sqliteFile), { recursive: true });
    sqlite = new DatabaseSync(sqliteFile);
    const syncMode = String(process.env.DB_SQLITE_SYNC || 'NORMAL').toUpperCase();
    try {
      sqlite.exec('PRAGMA journal_mode = WAL');
      sqlite.exec('PRAGMA synchronous = ' + (/^(OFF|NORMAL|FULL|EXTRA)$/.test(syncMode) ? syncMode : 'NORMAL'));
      sqlite.exec('PRAGMA foreign_keys = OFF');
      sqlite.exec('PRAGMA busy_timeout = 4000');
    } catch (e) {
      log('[store] PRAGMA 失败（不影响使用）:', e.message);
    }
    // feedbacks 表的列名与其它表不同，单独建，避免与通用模板冲突
    for (const sql of SCHEMA) sqlite.exec(sql);
    stmts = {
      upsert: {},
      del: {},
      all: {}
    };
    for (const kind of Object.keys(COLLECTIONS)) {
      stmts.upsert[kind] = sqlite.prepare(upsertSql(kind));
      stmts.del[kind] = sqlite.prepare('DELETE FROM ' + COLLECTIONS[kind].table + ' WHERE k=?');
      stmts.all[kind] = sqlite.prepare('SELECT k, body FROM ' + COLLECTIONS[kind].table + ' ORDER BY rowid');
    }
    for (const kind of Object.keys(MAPS)) {
      sqlite.exec(mapCreateSql(kind));
      stmts.upsert[kind] = sqlite.prepare(mapUpsertSql(kind));
      stmts.del[kind] = sqlite.prepare('DELETE FROM ' + MAPS[kind].table + ' WHERE k=?');
      stmts.all[kind] = sqlite.prepare('SELECT k, body FROM ' + MAPS[kind].table + ' ORDER BY rowid');
    }
    ready = true;
    return true;
  }

  function setSchemaVersion() {
    if (!sqlite) return;
    sqlite.prepare('INSERT INTO schema_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
      .run('version', String(SCHEMA_VERSION));
  }

  function hasData() {
    if (!sqlite) return false;
    for (const table of ['problems', 'users', 'posts', 'submissions', 'feedbacks']) {
      const row = sqlite.prepare('SELECT COUNT(*) AS n FROM ' + table).get();
      if (row && Number(row.n) > 0) return true;
    }
    return false;
  }

  function load() {
    if (engine !== 'sqlite') return null;
    open();
    if (!hasData()) return null;
    const out = { problems: [], users: [], posts: [], submissions: [], feedbacks: [], sessions: {}, daily: {}, emailCodes: {} };
    for (const kind of Object.keys(COLLECTIONS)) {
      for (const row of stmts.all[kind].all()) {
        try { out[kind].push(JSON.parse(row.body)); } catch (e) { log('[store] 跳过损坏行', kind, row.k, e.message); }
      }
    }
    const now = Date.now();
    for (const kind of Object.keys(MAPS)) {
      const bag = out[kind];
      for (const row of stmts.all[kind].all()) {
        let val;
        try { val = JSON.parse(row.body); } catch (e) { continue; }
        if (kind === 'sessions' && !(val && val.exp > now)) continue;
        bag[row.k] = val;
      }
    }
    const kv = new Map();
    for (const row of sqlite.prepare('SELECT k, body FROM kv').all()) {
      try { kv.set(row.k, JSON.parse(row.body)); } catch (e) {}
    }
    out.settings = kv.get('settings') || {};
    out.meta = kv.get('meta') || {};
    return out;
  }

  /* 全量导入：迁移脚本与「首次切到 sqlite」共用 */
  function importAll(dbObj) {
    open();
    const tx = () => {
      for (const kind of Object.keys(COLLECTIONS)) {
        const def = COLLECTIONS[kind];
        const rows = Array.isArray(dbObj[kind]) ? dbObj[kind] : [];
        sqlite.exec('DELETE FROM ' + def.table);
        for (const row of rows) upsertRow(kind, row);
      }
      for (const kind of Object.keys(MAPS)) {
        const bag = dbObj[kind] && typeof dbObj[kind] === 'object' ? dbObj[kind] : {};
        sqlite.exec('DELETE FROM ' + MAPS[kind].table);
        for (const k of Object.keys(bag)) upsertMapRow(kind, k, bag[k]);
      }
      sqlite.prepare('DELETE FROM kv').run();
      sqlite.prepare('INSERT INTO kv(k,body) VALUES(?,?)').run('settings', JSON.stringify(dbObj.settings || {}));
      sqlite.prepare('INSERT INTO kv(k,body) VALUES(?,?)').run('meta', JSON.stringify(dbObj.meta || {}));
    };
    sqlite.exec('BEGIN IMMEDIATE');
    try { tx(); sqlite.exec('COMMIT'); } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    setSchemaVersion();
  }

  function upsertRow(kind, row) {
    const def = COLLECTIONS[kind];
    const extra = def.extra(row) || {};
    const cols = collectionExtraKeys(kind);
    const values = [keyOf(kind, row)].concat(cols.map((c) => extra[c]), [JSON.stringify(row)]);
    stmts.upsert[kind].run(...values);
  }

  function upsertMapRow(kind, key, val) {
    const extra = MAPS[kind].extra(val);
    const names = MAPS[kind].cols;
    stmts.upsert[kind].run(key, ...names.map((n) => extra[n]), JSON.stringify(val));
  }

  function attach(dbObj) {
    if (engine !== 'sqlite') { attached = dbObj; return dbObj; }
    open();
    attached = dbObj;
    return wrap(dbObj, { root: true });
  }

  function save(dbProxy) {
    if (engine !== 'sqlite' || !ready) return { wrote: 0 };
    const dbObj = attached || dbProxy;
    const t0 = Date.now();
    let wrote = 0;
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      for (const kind of [...structural]) {
        const def = COLLECTIONS[kind] || MAPS[kind];
        if (!def) { structural.delete(kind); continue; }
        sqlite.exec('DELETE FROM ' + def.table);
        if (COLLECTIONS[kind]) {
          const rows = Array.isArray(dbObj[kind]) ? dbObj[kind] : [];
          for (const row of rows) { upsertRow(kind, row); wrote++; }
        } else {
          const bag = dbObj[kind] && typeof dbObj[kind] === 'object' ? dbObj[kind] : {};
          for (const k of Object.keys(bag)) { upsertMapRow(kind, k, bag[k]); wrote++; }
        }
        structural.delete(kind);
        dirty.delete(kind);
      }
      for (const [kind, keys] of [...dirty]) {
        if (!keys.size) { dirty.delete(kind); continue; }
        if (COLLECTIONS[kind]) {
          const rows = Array.isArray(dbObj[kind]) ? dbObj[kind] : [];
          const index = new Map();
          for (const row of rows) index.set(keyOf(kind, row), row);
          for (const key of keys) {
            const row = index.get(key);
            if (row) { upsertRow(kind, row); wrote++; } else { stmts.del[kind].run(key); wrote++; }
          }
        } else if (MAPS[kind]) {
          const bag = dbObj[kind] && typeof dbObj[kind] === 'object' ? dbObj[kind] : {};
          for (const key of keys) {
            if (bag[key] === undefined) stmts.del[kind].run(key);
            else { upsertMapRow(kind, key, bag[key]); wrote++; }
          }
        }
        dirty.delete(kind);
      }
      if (kvDirty.size) {
        const kv = sqlite.prepare('INSERT INTO kv(k,body) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET body=excluded.body');
        for (const key of kvDirty) kv.run(key, JSON.stringify(dbObj[key] || {}));
        wrote += kvDirty.size;
        kvDirty.clear();
      }
      sqlite.exec('COMMIT');
    } catch (e) {
      try { sqlite.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
    lastFlushMs = Date.now() - t0;
    flushCount++;
    if (reconcileEvery > 0 && flushCount % reconcileEvery === 0) {
      try { reconcile(dbObj); } catch (e) { log('[store] 对账失败:', e.message); }
    }
    maybeMirror(dbObj);
    return { wrote, ms: lastFlushMs };
  }

  /* 对账：行数与数组长度不一致就整表重建，防止 Proxy 漏记导致的静默丢数据 */
  function reconcile(dbObj) {
    if (!sqlite) return;
    const bad = [];
    for (const kind of Object.keys(COLLECTIONS)) {
      const n = Number(sqlite.prepare('SELECT COUNT(*) AS n FROM ' + COLLECTIONS[kind].table).get().n);
      const arr = Array.isArray(dbObj[kind]) ? dbObj[kind] : [];
      if (n !== arr.length) bad.push(kind + ' ' + n + '≠' + arr.length);
    }
    for (const kind of Object.keys(MAPS)) {
      const n = Number(sqlite.prepare('SELECT COUNT(*) AS n FROM ' + MAPS[kind].table).get().n);
      const bag = dbObj[kind] && typeof dbObj[kind] === 'object' ? dbObj[kind] : {};
      const want = kind === 'sessions' ? Object.keys(bag).filter((k) => bag[k] && bag[k].exp > Date.now()).length : Object.keys(bag).length;
      if (n !== want) bad.push(kind + ' ' + n + '≠' + want);
    }
    if (bad.length) {
      log('[store] 行数对不上，整表重建: ' + bad.join(' | '));
      for (const kind of Object.keys(COLLECTIONS).concat(Object.keys(MAPS))) structural.add(kind);
      save(dbObj);
    }
    // 顺手清掉过期会话与验证码
    try {
      sqlite.prepare('DELETE FROM sessions WHERE exp<=?').run(Date.now());
      sqlite.prepare('DELETE FROM email_codes WHERE exp<=?').run(Date.now());
    } catch (_) {}
  }

  function maybeMirror(dbObj) {
    if (!mirrorJson || engine !== 'sqlite') return;
    const now = Date.now();
    if (now - lastMirrorAt < mirrorInterval) return;
    mirror(dbObj);
  }

  function mirror(dbObj) {
    if (!mirrorJson || engine !== 'sqlite') return false;
    try {
      const tmp = dbPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(attached || dbObj, null, 2), 'utf8');
      fs.renameSync(tmp, dbPath);
      lastMirrorAt = Date.now();
      return true;
    } catch (e) {
      log('[store] 导出 db.json 失败:', e.message);
      return false;
    }
  }

  /* WAL 落盘：备份 sqlite 文件前先 checkpoint，避免只拷到主文件、丢了 -wal 里的最新行 */
  function checkpoint() {
    if (!sqlite) return;
    try { sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { log('[store] checkpoint 失败:', e.message); }
  }

  function close(dbObj) {
    if (engine !== 'sqlite' || !sqlite) return;
    try {
      if (dirty.size || structural.size || kvDirty.size) save(dbObj);
      mirror(attached || dbObj);
    } catch (e) {
      log('[store] 关闭前落盘失败:', e.message);
    }
    try { sqlite.close(); } catch (_) {}
    sqlite = null;
    ready = false;
  }

  function countOf(kind) {
    if (!sqlite) return 0;
    const def = COLLECTIONS[kind] || MAPS[kind];
    if (!def) return 0;
    return Number(sqlite.prepare('SELECT COUNT(*) AS n FROM ' + def.table).get().n);
  }

  function stats() {
    return {
      engine,
      file: engine === 'sqlite' ? sqliteFile : dbPath,
      ready,
      counts: engine === 'sqlite' && ready
        ? Object.keys(COLLECTIONS).concat(Object.keys(MAPS)).reduce((acc, k) => { acc[k] = countOf(k); return acc; }, {})
        : {},
      dirty: [...dirty].reduce((n, [, s]) => n + s.size, 0),
      flushes: flushCount,
      lastFlushMs,
      mirrorJson,
      sizeBytes: (() => { try { return fs.statSync(engine === 'sqlite' ? sqliteFile : dbPath).size; } catch (e) { return 0; } })()
    };
  }

  /* 把库内容与 sqlite 里的内容做一次严格比对，给迁移脚本用 */
  function verify(dbObj) {
    open();
    try {
      sqlite.prepare('DELETE FROM sessions WHERE exp<=?').run(Date.now());
      sqlite.prepare('DELETE FROM email_codes WHERE exp<=?').run(Date.now());
    } catch (_) {}
    const problems = [];
    for (const kind of Object.keys(COLLECTIONS)) {
      const arr = Array.isArray(dbObj[kind]) ? dbObj[kind] : [];
      const rows = stmts.all[kind].all();
      if (rows.length !== arr.length) problems.push(kind + ': 行数 ' + rows.length + ' ≠ ' + arr.length);
      const byKey = new Map(rows.map((r) => [r.k, r.body]));
      let mismatch = 0;
      for (const row of arr) {
        const k = keyOf(kind, row);
        const body = byKey.get(k);
        if (body === undefined) { mismatch++; continue; }
        if (body !== JSON.stringify(row)) mismatch++;
      }
      if (mismatch) problems.push(kind + ': ' + mismatch + ' 行内容不一致');
    }
    for (const kind of Object.keys(MAPS)) {
      const bag = dbObj[kind] && typeof dbObj[kind] === 'object' ? dbObj[kind] : {};
      const rows = stmts.all[kind].all();
      const want = kind === 'sessions' ? Object.keys(bag).filter((k) => bag[k] && bag[k].exp > Date.now()) : Object.keys(bag);
      if (rows.length !== want.length) problems.push(kind + ': 行数 ' + rows.length + ' ≠ ' + want.length);
    }
    return { ok: problems.length === 0, problems };
  }

  return {
    engine,
    get ready() { return ready; },
    dbPath,
    sqliteFile,
    open,
    load,
    attach,
    save,
    close,
    checkpoint,
    importAll,
    verify,
    reconcile,
    mirror,
    stats,
    hasData,
    SCHEMA_VERSION
  };
}

module.exports = { createStore, SCHEMA_VERSION, COLLECTIONS, MAPS };
