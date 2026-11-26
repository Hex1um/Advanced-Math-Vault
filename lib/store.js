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

const { runMigrations, LATEST_VERSION } = require('./migrations');
const SCHEMA_VERSION = LATEST_VERSION;

/* 集合型（数组）数据：key 用于行主键，extra 抽成索引列 */
/* 学科归一化：只有明确的 physics 才算物理，其余（含 undefined / 拼错 / 空）都是 math。
   与 tag-taxonomy.subjectOf 保持一致；这里不能 require，避免 store 被标签模块反向依赖。 */
function normSubject(v) {
  return String(v || '').toLowerCase() === 'physics' ? 'physics' : 'math';
}

const COLLECTIONS = {
  problems: {
    table: 'problems',
    key: (r) => r && r.code,
    extra: (r) => ({
      status: String(r.status || ''),
      main_tag: String(r.mainTag || ''),
      sub_tag: String((Array.isArray(r.tags) && r.tags[0]) || ''),
      difficulty: Number(r.difficulty) || 0,
      /* v2.7.0：学科命名空间。历史数据缺字段时一律落 'math'，与读取侧归一化一致；
         physics_meta 只对物理题写 JSON 字符串，数学题为空串（省空间，也便于
         `WHERE physics_meta != ''` 这类运维查询）。 */
      subject: normSubject(r.subject),
      physics_meta: r.physicsMeta && typeof r.physicsMeta === 'object' ? JSON.stringify(r.physicsMeta) : ''
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
  },
  /* 个性化题单：v2 迁移建表，结构与其他集合一致（k + 索引列 + body），
     这样整表重建 / 行级 upsert 的通用逻辑可以原样复用。 */
  collections: {
    table: 'collections',
    key: (r) => r && r.id,
    extra: (r) => ({
      owner_id: String(r.ownerId || ''),
      title: String(r.title || ''),
      is_public: r.isPublic ? 1 : 0,
      updated_at: Number(r.updatedAt) || 0
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
  'CREATE TABLE IF NOT EXISTS problems (k TEXT PRIMARY KEY, status TEXT, main_tag TEXT, sub_tag TEXT, difficulty INTEGER, subject TEXT NOT NULL DEFAULT \'math\', physics_meta TEXT, body TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_problems_tag ON problems(status, main_tag, difficulty)',
  'CREATE INDEX IF NOT EXISTS idx_problems_sub ON problems(sub_tag)',
  'CREATE INDEX IF NOT EXISTS idx_problems_subject_maintag ON problems(subject, main_tag)',
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
  'CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
  /* 搜索索引：把「可搜索字段」拼成一行小文本，用 LIKE 做子串匹配。
     为什么不用 FTS5：trigram 分词器只支持 >=3 字符的查询，而本库最常见的是
     「积分」「极限」「导数」这类 2 字中文查询，MATCH 直接 0 命中；
     unicode61 又会把整段中文当成一个 token。LIKE 子串与原来的
     String.includes 语义完全一致，扫描一个窄表也远比 JSON.parse 6400 个 body 便宜。 */
  'CREATE TABLE IF NOT EXISTS problem_search (k TEXT PRIMARY KEY, text TEXT NOT NULL)'
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
  return {
    problems: ['status', 'main_tag', 'sub_tag', 'difficulty', 'subject', 'physics_meta'],
    users: ['name', 'email'],
    posts: ['author_id', 'problem_code', 'created_at'],
    submissions: ['user_id', 'problem_code', 'score', 'created_at'],
    feedbacks: ['code', 'status', 'created_at'],
    collections: ['owner_id', 'title', 'is_public', 'updated_at']
  }[kind];
}

function upsertSql(kind) {
  const cols = collectionExtraKeys(kind);
  const all = ['k'].concat(cols, ['body']);
  return 'INSERT INTO ' + COLLECTIONS[kind].table + '(' + all.join(',') + ') VALUES('
    + all.map(() => '?').join(',') + ') ON CONFLICT(k) DO UPDATE SET '
    + cols.concat(['body']).map((c) => c + '=excluded.' + c).join(', ');
}

/** 参与搜索的字段（与 routes 里内存过滤的字段集保持一致，改一处要同步另一处） */
function searchTextOf(row) {
  const parts = [
    row && row.title,
    row && row.code,
    row && row.mainTag,
    ...(Array.isArray(row && row.examTags) ? row.examTags : []),
    ...(Array.isArray(row && row.tags) ? row.tags : []),
    row && row.source
  ];
  return parts.filter((x) => x !== undefined && x !== null && x !== '').join('\u0001').toLowerCase();
}

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
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
  let searchStmt = null;

  /* ---- 变更追踪 ---- */
  const proxies = new WeakMap();   // raw → proxy
  const proxySet = new WeakSet();  // 已代理对象（避免重复包裹）
  const dirty = new Map();         // kind → Set(key)
  const deleted = new Map();       // kind → Set(key)：精确 DELETE，不整表重建
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

  function markDeleted(kind, key) {
    if (key === undefined || key === null || key === '') { structural.add(kind); return; }
    let s = deleted.get(kind);
    if (!s) { s = new Set(); deleted.set(kind, s); }
    s.add(String(key));
    const d = dirty.get(kind);
    if (d) d.delete(String(key));
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

  /* 集合数组的原地增删（push/splice 等）按 key 差集处理：
     新增的只 UPSERT 那一行，删掉的只 DELETE 那一行。
     以前只要 push 一个元素就把整表标记 structural，6400 题的库单次投稿
     会 DELETE 全表再重插 6400 行——这是最贵的一处写放大。 */
  const MUTATORS = ['push', 'pop', 'shift', 'unshift', 'splice'];

  function keySet(kind, arr) {
    const out = new Set();
    for (const row of arr || []) {
      const k = keyOf(kind, row);
      if (k) out.add(k);
    }
    return out;
  }

  function trackArrayChange(kind, beforeKeys, target) {
    const afterKeys = keySet(kind, target);
    for (const k of afterKeys) if (!beforeKeys.has(k)) markDirty(kind, k);
    for (const k of beforeKeys) if (!afterKeys.has(k)) markDeleted(kind, k);
    // 元素缺少主键时无法定位行，退回整表重建兜底（脏数据不静默丢）
    if (afterKeys.size !== target.length) structural.add(kind);
  }

  function arrayHandler(parentCtx) {
    return {
      get(target, prop, receiver) {
        if (parentCtx && parentCtx.collection && MUTATORS.indexOf(prop) >= 0) {
          const kind = parentCtx.collection;
          return function () {
            const beforeKeys = keySet(kind, target);
            const res = Array.prototype[prop].apply(target, arguments);
            try { trackArrayChange(kind, beforeKeys, target); } catch (e) { structural.add(kind); }
            return res;
          };
        }
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
        if (parentCtx && parentCtx.collection) {
          const kind = parentCtx.collection;
          if (prop === 'length') {
            const next = Number(value);
            const shrunk = Number.isFinite(next) && next < target.length;
            const removed = shrunk ? target.slice(Math.max(0, next)) : [];
            const ok = Reflect.set(target, prop, value, receiver);
            for (const row of removed) markDeleted(kind, keyOf(kind, row));
            return ok;
          }
          if (/^\d+$/.test(String(prop))) {
            const oldKey = keyOf(kind, target[prop]);
            const newKey = keyOf(kind, value);
            const ok = Reflect.set(target, prop, value, receiver);
            if (oldKey && oldKey !== newKey) markDeleted(kind, oldKey);
            if (newKey) markDirty(kind, newKey);
            else structural.add(kind);
            return ok;
          }
        }
        const ok = Reflect.set(target, prop, value, receiver);
        if (parentCtx && parentCtx.row) {
          markDirty(parentCtx.row.kind, keyOf(parentCtx.row.kind, parentCtx.row.target));
        } else if (parentCtx && parentCtx.kv) {
          kvDirty.add(parentCtx.kv);
        } else if (parentCtx && parentCtx.map) {
          markDirty(parentCtx.map, parentCtx.entryKey || prop);
        }
        return ok;
      },
      deleteProperty(target, prop) {
        if (parentCtx && parentCtx.collection) {
          const row = /^\d+$/.test(String(prop)) ? target[prop] : null;
          const ok = Reflect.deleteProperty(target, prop);
          if (row) markDeleted(parentCtx.collection, keyOf(parentCtx.collection, row));
          else if (String(prop) !== 'length') structural.add(parentCtx.collection);
          return ok;
        }
        const ok = Reflect.deleteProperty(target, prop);
        if (parentCtx && parentCtx.row) {
          markDirty(parentCtx.row.kind, keyOf(parentCtx.row.kind, parentCtx.row.target));
        } else if (parentCtx && parentCtx.map) {
          markDirty(parentCtx.map, parentCtx.entryKey || prop);
        } else if (parentCtx && parentCtx.kv) {
          kvDirty.add(parentCtx.kv);
        }
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
          if (parentCtx && parentCtx.map) {
            /* 关键：必须把条目主键（session token / email / 日期）一路带下去。
               以前这里只传 { map }，db.sessions[token].exp = x 会被记成
               markDirty('sessions', 'exp')，增量落盘就静默丢了这次修改。 */
            return wrap(v, { map: parentCtx.map, entryKey: parentCtx.entryKey || prop });
          }
          if (parentCtx && parentCtx.row) return wrap(v, parentCtx);
          return wrap(v, parentCtx);
        }
        return v;
      },
      set(obj, prop, value, receiver) {
        const ok = Reflect.set(obj, prop, value, receiver);
        if (parentCtx && parentCtx.root) {
          if (COLLECTIONS[prop] || MAPS[prop]) { structural.add(prop); dirty.delete(prop); deleted.delete(prop); }
          else if (prop === 'settings' || prop === 'meta') kvDirty.add(prop);
        } else if (parentCtx && parentCtx.map) {
          markDirty(parentCtx.map, parentCtx.entryKey || prop);
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
        if (parentCtx && parentCtx.map) markDeleted(parentCtx.map, parentCtx.entryKey || prop);
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
    /* 版本化迁移：老库补新表/新索引，每步独立事务，失败整步回滚 */
    try {
      runMigrations(sqlite, { log });
    } catch (e) {
      log('[store] 迁移失败:', e.message);
      throw e;
    }
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
    searchStmt = {
      upsert: sqlite.prepare('INSERT INTO problem_search(k,text) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET text=excluded.text'),
      del: sqlite.prepare('DELETE FROM problem_search WHERE k=?'),
      find: sqlite.prepare("SELECT k FROM problem_search WHERE text LIKE ? ESCAPE '\\' LIMIT ?"),
      count: sqlite.prepare('SELECT COUNT(*) AS n FROM problem_search')
    };
    backfillSearch();
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
        if (kind === 'problems' && searchStmt) {
          try { sqlite.exec('DELETE FROM problem_search'); } catch (e) {}
        }
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
    const key = keyOf(kind, row);
    const values = [key].concat(cols.map((c) => extra[c]), [JSON.stringify(row)]);
    stmts.upsert[kind].run(...values);
    if (kind === 'problems' && searchStmt && key) {
      try { searchStmt.upsert.run(key, searchTextOf(row)); } catch (e) { log('[store] 搜索索引写入失败:', e.message); }
    }
  }

  /* 首次启用（或老库升级）时把 problems 全部灌进搜索索引 */
  function backfillSearch() {
    if (!searchStmt) return;
    try {
      const inTable = Number(searchStmt.count.get().n);
      const problems = Number(sqlite.prepare('SELECT COUNT(*) AS n FROM problems').get().n);
      if (inTable === problems) return;
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        sqlite.exec('DELETE FROM problem_search');
        const rows = sqlite.prepare('SELECT k, body FROM problems ORDER BY rowid').all();
        for (const r of rows) {
          let obj;
          try { obj = JSON.parse(r.body); } catch (e) { continue; }
          searchStmt.upsert.run(r.k, searchTextOf(obj));
        }
        sqlite.exec('COMMIT');
      } catch (e) {
        try { sqlite.exec('ROLLBACK'); } catch (_) {}
        throw e;
      }
      log('[store] 搜索索引已重建：' + problems + ' 题');
    } catch (e) {
      log('[store] 搜索索引回填失败（查询会自动退回全表扫描）:', e.message);
    }
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
        if (kind === 'problems' && searchStmt) {
          try { sqlite.exec('DELETE FROM problem_search'); } catch (e) {}
        }
        if (COLLECTIONS[kind]) {
          const rows = Array.isArray(dbObj[kind]) ? dbObj[kind] : [];
          for (const row of rows) { upsertRow(kind, row); wrote++; }
        } else {
          const bag = dbObj[kind] && typeof dbObj[kind] === 'object' ? dbObj[kind] : {};
          for (const k of Object.keys(bag)) { upsertMapRow(kind, k, bag[k]); wrote++; }
        }
        structural.delete(kind);
        dirty.delete(kind);
        deleted.delete(kind);
      }
      // 精确删除：只删掉被删元素那一行，不再为了删一条记录重建整表
      for (const [kind, keys] of [...deleted]) {
        if (!keys.size) { deleted.delete(kind); continue; }
        if (stmts.del[kind]) {
          for (const key of keys) {
            stmts.del[kind].run(String(key));
            if (kind === 'problems' && searchStmt) { try { searchStmt.del.run(String(key)); } catch (e) {} }
            wrote++;
          }
        }
        deleted.delete(kind);
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
    const raw = attached || dbObj;
    const now = Date.now();
    /* 先清过期行再比行数。原实现先 COUNT(*) 再清过期，而内存侧过滤了 exp>now：
       表里只要存着一条过期会话，两边就永远不等，每 reconcileEvery 次保存
       都会误触发一次 10 张表的全库重建。 */
    try {
      sqlite.prepare('DELETE FROM sessions WHERE exp<=?').run(now);
      sqlite.prepare('DELETE FROM email_codes WHERE exp<=?').run(now);
    } catch (_) {}
    for (const kind of ['sessions', 'emailCodes']) {
      const bag = raw[kind];
      if (!bag || typeof bag !== 'object') continue;
      for (const k of Object.keys(bag)) {
        if (!(bag[k] && Number(bag[k].exp) > now)) delete bag[k];
      }
    }
    const bad = [];
    for (const kind of Object.keys(COLLECTIONS)) {
      const n = Number(sqlite.prepare('SELECT COUNT(*) AS n FROM ' + COLLECTIONS[kind].table).get().n);
      const arr = Array.isArray(raw[kind]) ? raw[kind] : [];
      if (n !== arr.length) bad.push(kind + ' ' + n + '≠' + arr.length);
    }
    for (const kind of Object.keys(MAPS)) {
      const n = Number(sqlite.prepare('SELECT COUNT(*) AS n FROM ' + MAPS[kind].table).get().n);
      const bag = raw[kind] && typeof raw[kind] === 'object' ? raw[kind] : {};
      const want = Object.keys(bag).length;
      if (n !== want) bad.push(kind + ' ' + n + '≠' + want);
    }
    if (bad.length) {
      log('[store] 行数对不上，整表重建: ' + bad.join(' | '));
      for (const kind of Object.keys(COLLECTIONS).concat(Object.keys(MAPS))) structural.add(kind);
      save(raw);
    }
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

  /**
   * 原子热备份：VACUUM INTO 在 SQLite 内部做一致性快照，不阻塞读、不会像
   * copyFile 那样把写了一半的页拷走（WAL 模式下尤其危险）。
   * 失败返回 false，由调用方决定是否回退到文件拷贝。
   */
  function backupTo(file) {
    if (engine !== 'sqlite' || !sqlite) return false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const target = String(file).replace(/'/g, "''");
      sqlite.exec("VACUUM INTO '" + target + "'");
      return true;
    } catch (e) {
      log('[store] VACUUM INTO 备份失败:', e.message);
      return false;
    }
  }

  function close(dbObj) {
    if (engine !== 'sqlite' || !sqlite) return;
    try {
      if (dirty.size || deleted.size || structural.size || kvDirty.size) save(dbObj);
      mirror(attached || dbObj);
    } catch (e) {
      log('[store] 关闭前落盘失败:', e.message);
    }
    try { sqlite.close(); } catch (_) {}
    sqlite = null;
    ready = false;
  }

  /**
   * 按关键词返回命中的题号集合（只用于缩小候选，最终仍由内存谓词精确判定）。
   * @returns {?Set<string>} null 表示索引不可用，调用方应退回全表过滤
   */
  function searchProblemCodes(q, opts) {
    if (engine !== 'sqlite' || !ready || !searchStmt) return null;
    const term = String(q == null ? '' : q).trim().toLowerCase();
    if (!term) return new Set();
    const limit = Math.max(1, Number((opts && opts.limit) || 50000));
    try {
      const rows = searchStmt.find.all('%' + escapeLike(term) + '%', limit);
      return new Set(rows.map((r) => String(r.k)));
    } catch (e) {
      log('[store] 搜索索引查询失败，退回全表:', e.message);
      return null;
    }
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
      pendingDeletes: [...deleted].reduce((n, [, s]) => n + s.size, 0),
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
    backupTo,
    importAll,
    verify,
    reconcile,
    mirror,
    stats,
    hasData,
    searchProblemCodes,
    SCHEMA_VERSION
  };
}

module.exports = { createStore, SCHEMA_VERSION, COLLECTIONS, MAPS };
