/**
 * 零依赖轻量路由器（支持路径参数、通配前缀与洋葱中间件）
 *
 * 设计取舍：
 *   - 不用正则全路径重写，只在注册时把 `:param` 与 `*` 编译成捕获组，避免每次请求重复解析；
 *   - 中间件是标准 `(rc, next)` 洋葱模型：鉴权、角色、限流都可声明式挂载；
 *   - `dispatch` 返回是否命中路由，未命中由调用方回 404 —— 与拆分前的
 *     「一路 if 到底、最后 fail 404」行为一致，便于逐域迁移。
 */
'use strict';

class Router {
  constructor() {
    this.routes = [];
    this.globalMiddlewares = [];
  }

  use(mw) {
    this.globalMiddlewares.push(mw);
    return this;
  }

  add(method, pattern, ...handlers) {
    const keys = [];
    let regexStr = String(pattern || '/').replace(/\/+$/, '');
    if (!regexStr) regexStr = '/';
    regexStr = regexStr.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    regexStr = regexStr
      .replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      })
      .replace(/\*/g, '(.*)');
    const regex = new RegExp(`^${regexStr || '/'}/?$`);
    this.routes.push({
      method: String(method).toUpperCase(),
      pattern,
      regex,
      keys,
      handlers: handlers.flat().filter((h) => typeof h === 'function'),
    });
    return this;
  }

  get(p, ...h) { return this.add('GET', p, ...h); }
  post(p, ...h) { return this.add('POST', p, ...h); }
  put(p, ...h) { return this.add('PUT', p, ...h); }
  patch(p, ...h) { return this.add('PATCH', p, ...h); }
  delete(p, ...h) { return this.add('DELETE', p, ...h); }
  all(p, ...h) { return this.add('ALL', p, ...h); }

  /** 挂载子路由模块：registerFn(router, ctx) */
  mount(registerFn, ctx) {
    registerFn(this, ctx);
    return this;
  }

  async dispatch(req, res, ctx, extra = {}) {
    const method = (req.method || 'GET').toUpperCase();
    const pathname = extra.pathname || '/';

    for (const route of this.routes) {
      if (route.method !== method && route.method !== 'ALL') continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;

      const params = {};
      route.keys.forEach((k, i) => {
        try {
          params[k] = decodeURIComponent(m[i + 1]);
        } catch (e) {
          params[k] = m[i + 1];
        }
      });

      const reqCtx = {
        req,
        res,
        ctx,
        pathname,
        method,
        query: extra.query || {},
        params,
        user: extra.user || null,
      };

      const chain = [...this.globalMiddlewares, ...route.handlers];
      let idx = -1;

      const next = async () => {
        idx += 1;
        if (idx < chain.length) {
          return chain[idx](reqCtx, next);
        }
        return undefined;
      };

      await next();
      return true;
    }
    return false;
  }
}

/* 常用声明式守卫中间件 */
function requireAuth(rc, next) {
  if (!rc.user) {
    return rc.ctx.http.fail(rc.res, 401, '请先登录后再操作');
  }
  return next();
}

function requireAdmin(rc, next) {
  if (!rc.user || rc.user.role !== 'admin') {
    return rc.ctx.http.fail(rc.res, 403, '需要管理员权限');
  }
  return next();
}

function withRateLimit(bucket, maxPerWindow, windowMs) {
  return (rc, next) => {
    const ip = rc.ctx.http.clientIp(rc.req, { trustProxy: rc.ctx.config && rc.ctx.config.trustProxy });
    const key = `${bucket}:${rc.user ? rc.user.id : ip}`;
    if (!rc.ctx.ratelimit.allow(key, maxPerWindow, windowMs)) {
      return rc.ctx.http.fail(rc.res, 429, '操作过于频繁，请稍后再试');
    }
    return next();
  };
}

/**
 * 把「路径正则 + 配额」表编译成全局中间件（POST 才生效）。
 * 与拆分前 server.js 顶部那段循环完全等价：命中即计数，超限 429。
 */
function rateRulesMiddleware(rules, opts = {}) {
  const trustProxy = !!opts.trustProxy;
  return (rc, next) => {
    if (rc.method !== 'POST') return next();
    const ip = rc.ctx.http.clientIp(rc.req, { trustProxy });
    for (const [re, limit, win, msg] of rules) {
      if (re.test(rc.pathname) && !rc.ctx.ratelimit.hit(ip + '|' + rc.pathname, limit, win)) {
        return rc.ctx.http.fail(rc.res, 429, msg);
      }
    }
    return next();
  };
}

module.exports = { Router, requireAuth, requireAdmin, withRateLimit, rateRulesMiddleware };
