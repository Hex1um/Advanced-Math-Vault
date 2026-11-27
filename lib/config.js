/**
 * 运行期配置：路径、端口、站点身份与安全开关。
 *
 * 所有环境变量只在这里读一次，server.js / lib/core.js 共享同一份值，
 * 避免「两处各算一遍，改了一处忘另一处」。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { loadDotEnv } = require('./env');

const ROOT = path.resolve(__dirname, '..');

/* 部署目录里的 .env（平台面板的环境变量优先，不会被覆盖）。
   测试与需要完全可控环境的场景用 MV_NO_DOTENV=1 关掉，否则一个遗留的 .env
   会悄悄改掉 TRUST_PROXY / NODE_ENV 这类开关，让冒烟测试结果不可复现。 */
if (process.env.MV_NO_DOTENV !== '1') {
  loadDotEnv(path.join(ROOT, '.env'), { log: (m) => console.log(m) });
}

const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'db.json');
const SEED_FILE = process.env.SEED_FILE || path.join(DATA_DIR, 'problems.seed.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const SITE_NAME = process.env.SITE_NAME || '数海晴岸';

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || ''; } catch (e) { return ''; }
})();

/* 线上到底跑的是哪一份代码：部署时由 tools/ops/deploy.mjs 写 data/build-info.json，
   本地开发退回 .git/HEAD。没有这一项，历史上出现过「线上版本号在仓库里查不到」的情况，
   事后完全无法定位代码状态。 */
const BUILD_INFO = (() => {
  const out = { commit: '', builtAt: '', dirty: false };
  try {
    const f = path.join(DATA_DIR, 'build-info.json');
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      out.commit = String(j.commit || '');
      out.builtAt = String(j.builtAt || '');
      out.dirty = !!j.dirty;
    }
  } catch (e) { /* 读不到就当没有 */ }
  if (!out.commit) {
    const env = String(process.env.GIT_COMMIT || '').trim();
    if (env) out.commit = env;
  }
  if (!out.commit) {
    try {
      const head = String(fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8')).trim();
      const ref = head.match(/^ref:\s*(.+)$/);
      out.commit = ref ? String(fs.readFileSync(path.join(ROOT, '.git', ref[1]), 'utf8')).trim() : head;
    } catch (e) { /* 部署目录通常没有 .git */ }
  }
  out.commit = out.commit.replace(/[^0-9a-f]/gi, '').slice(0, 12);
  return out;
})();

/* 来源标签：不参与知识点主/子标签树，单独展示与筛选 */
const EXAM_TAGS = ['华科期中', '华科期末'];

/* 运行期调参（曾经是散落在 core.js / ai.js 里的裸数字）。
   集中在这里的理由很实际：改「刷盘防抖」以前要全库搜 400，改「会话时长」要搜 2592000，
   而且看代码的人不知道这个数字凭什么这么定。每项都标清含义，改动只改一处。 */
const TUNING = {
  SESSION_MAX_AGE: Number(process.env.SESSION_MAX_AGE || 2592000),  // 会话 Cookie 有效期（秒，30 天）
  SAVE_DEBOUNCE_MS: Number(process.env.SAVE_DEBOUNCE_MS || 400),    // JSON 引擎落盘防抖（毫秒）
  VIEW_SEEN_MAX: Number(process.env.VIEW_SEEN_MAX || 10000),        // 浏览去重表上限，防长期运行内存膨胀
  XP_CURVE: 25,        // 等级曲线：level = floor(sqrt(exp / 25)) + 1，升级所需经验随等级平方增长
  SCRYPT_KEYLEN: 64,   // scrypt 输出字节数 —— 与历史哈希一致，改了就没人能登录
  LLM_TEMPERATURE: Number(process.env.LLM_TEMPERATURE || 0.6)  // 判卷/答疑温度：要稳定不要发散
};

module.exports = {
  ROOT, PUBLIC_DIR, DATA_DIR, DB_FILE, SEED_FILE, UPLOAD_DIR,
  PORT, HOST, SITE_NAME, VERSION, EXAM_TAGS, BUILD_INFO, TUNING
};
