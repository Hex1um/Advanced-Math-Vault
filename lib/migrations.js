/**
 * 基于 node:sqlite 的声明式增量迁移引擎
 *
 * 背景：lib/store.js 原来只写死 SCHEMA_VERSION = 1，加表/加列只能靠「建库时
 * CREATE TABLE IF NOT EXISTS」碰运气 —— 老库升级时新列不会出现，索引也不会补。
 * 这里改成显式的版本化迁移：每步一个事务，失败整步回滚，成功后写 schema_meta。
 *
 * 约定：
 *   - 迁移不可回退（只做加法：加表、加索引、加可空列）；
 *   - 每条迁移必须幂等（IF NOT EXISTS），重跑不会报错；
 *   - 只依赖 node:sqlite 暴露的 exec/prepare，不引入第三方迁移库。
 */
'use strict';

const MIGRATIONS = [
  {
    version: 2,
    name: 'add_collections_and_bookmarks',
    up(sqlite) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS collections (
          k TEXT PRIMARY KEY,
          owner_id TEXT,
          title TEXT,
          is_public INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0,
          body TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(owner_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_collections_public ON collections(is_public, updated_at DESC);
      `);
    },
  },
  {
    version: 3,
    name: 'add_submission_time_index_for_heatmap',
    up(sqlite) {
      sqlite.exec(`
        CREATE INDEX IF NOT EXISTS idx_sub_user_created
        ON submissions(user_id, COALESCE(json_extract(body, '$.at'), json_extract(body, '$.createdAt')));
      `);
    },
  },
  {
    version: 4,
    name: 'add_ocr_badcases_and_streaks',
    up(sqlite) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS ocr_badcases (
          k TEXT PRIMARY KEY,
          uid TEXT,
          created_at TEXT,
          body TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_badcases_uid ON ocr_badcases(uid, created_at);
      `);
    },
  },
];

const LATEST_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 1);

function getCurrentVersion(sqlite) {
  try {
    const row = sqlite.prepare(`SELECT v FROM schema_meta WHERE k = 'version'`).get();
    return row ? Number(row.v) || 1 : 1;
  } catch (e) {
    return 1;
  }
}

function runMigrations(sqlite, logger = console) {
  const from = getCurrentVersion(sqlite);
  const pending = MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return { from, to: from, applied: [] };

  const applied = [];
  let current = from;
  for (const m of pending) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      m.up(sqlite);
      sqlite
        .prepare(`INSERT OR REPLACE INTO schema_meta (k, v) VALUES ('version', ?)`)
        .run(String(m.version));
      sqlite
        .prepare(`INSERT OR REPLACE INTO schema_meta (k, v) VALUES (?, ?)`)
        .run(`migrated_${m.version}`, new Date().toISOString());
      sqlite.exec('COMMIT');
      applied.push(`v${m.version}:${m.name}`);
      current = m.version;
      logger.log(`[migrate] applied v${m.version} (${m.name})`);
    } catch (err) {
      try { sqlite.exec('ROLLBACK'); } catch (e) { /* 事务可能已自动回滚 */ }
      throw new Error(`Migration v${m.version} (${m.name}) failed: ${err.message}`);
    }
  }
  return { from, to: current, applied };
}

module.exports = { runMigrations, MIGRATIONS, LATEST_VERSION };
