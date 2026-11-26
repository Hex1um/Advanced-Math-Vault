/**
 * 统一应用上下文容器（零依赖）
 *
 * 解决的是「28 依赖地狱」：路由模块原先要从 server.js 透传二十多个散乱入参，
 * 每拆一个域就要重新数一遍。现在所有共享基础设施收敛成单一 ctx：
 *
 *   ctx.db        实时 getter，始终指向最新的内存库（SQLite 热切换/重载后自动跟上）
 *   ctx.saveDb()  统一持久化入口，屏蔽 JSON / SQLite 差异
 *   ctx.services  业务能力（判题、AI、FSRS、标签、上传……）
 *   ctx.http      响应与请求解析
 *   ctx.config    路径、端口、版本
 *
 * 这样路由文件签名一律是 `module.exports = (router, ctx) => { ... }`。
 */
'use strict';

function createAppContext({
  store,
  ai,
  mail,
  fsrs,
  http,
  ratelimit,
  taxonomy,
  config,
  services = {},
  helpers = {},
}) {
  let _db = null;

  const ctx = {
    store,
    ai,
    mail,
    fsrs,
    http,
    ratelimit,
    taxonomy,
    config,
    services,
    helpers,

    /** 启动阶段或热重载时替换底层内存 db 引用 */
    setDb(nextDb) {
      _db = nextDb;
      return _db;
    },

    /** 统一持久化入口，屏蔽 JSON/SQLite 差异 */
    saveDb(reason = 'mutation') {
      if (!_db) throw new Error('Database not initialized');
      const save = services.saveDb || helpers.saveDb;
      if (typeof save === 'function') return save(reason);
      if (store && typeof store.save === 'function') return store.save(_db, reason);
      return undefined;
    },
  };

  // 通过只读 getter 始终指向最新 db 引用，彻底告别 getDb() 样板代码
  Object.defineProperty(ctx, 'db', {
    enumerable: true,
    get() {
      if (!_db) throw new Error('Database not initialized');
      return _db;
    },
  });

  return ctx;
}

module.exports = { createAppContext };
