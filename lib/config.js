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

/* 来源标签：不参与知识点主/子标签树，单独展示与筛选 */
const EXAM_TAGS = ['华科期中', '华科期末'];

module.exports = {
  ROOT, PUBLIC_DIR, DATA_DIR, DB_FILE, SEED_FILE, UPLOAD_DIR,
  PORT, HOST, SITE_NAME, VERSION, EXAM_TAGS
};
