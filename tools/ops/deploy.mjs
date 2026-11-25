#!/usr/bin/env node
/**
 * 安全部署：先跑 sync-live 把线上用户/帖子合并进本地库，再上传覆盖。
 *
 * 2026-11-24 事故复盘：直接用本地 db.json 部署，会把线上用户的帖子和经验一起覆盖掉。
 * 以后一律用 `node tools/ops/deploy.mjs` 发布，不要手工调发布工具。
 *
 * 用法：
 *   node tools/ops/deploy.mjs              # 同步 + 部署
 *   node tools/ops/deploy.mjs --no-sync    # 跳过同步（仅当确认线上无用户数据时）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const require = createRequire(import.meta.url);
const { parse: parseEnv } = require(path.join(ROOT, 'lib', 'env.js'));
const SKIP_SYNC = process.argv.includes('--no-sync');
const ALLOW_NO_SYNC = process.env.ALLOW_NO_SYNC === '1';
const PUBLISH = process.argv.includes('--publish') || process.env.USER_ASKED_TO_PUBLISH === '1';

/* 部署前自检：线上最常漏的两项（反代信任、跨域白名单）配错不会报错，只会静默降级 */
function preflight() {
  const envFile = path.join(ROOT, '.env');
  const fileEnv = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8'), process.env) : {};
  const merged = Object.assign({}, fileEnv, process.env);
  const warns = [];
  if (!fs.existsSync(envFile) && !process.env.TRUST_PROXY && !process.env.ALLOW_ORIGINS) {
    warns.push('没有 .env，也没有 TRUST_PROXY / ALLOW_ORIGINS：线上所有用户会共用代理 IP 的限流桶，且任何站点都能跨域调接口。');
    warns.push('建议：cp .env.production.example .env 填好后再部署。');
  }
  if (!/^(1|true|yes|on)$/i.test(String(merged.TRUST_PROXY || ''))) {
    warns.push('TRUST_PROXY 未开启：如果线上在反代后面，登录/AI/投稿的限流会按代理 IP 合并计算。');
  }
  const origins = String(merged.ALLOW_ORIGINS || '*');
  if (origins.trim() === '*') warns.push('ALLOW_ORIGINS 仍是 *：建议改成 https://hex1um.github.io。');
  if (warns.length) {
    console.log('⚠ 部署前配置检查：');
    for (const w of warns) console.log('  · ' + w);
  } else {
    console.log('✓ 部署前配置检查通过（TRUST_PROXY=' + merged.TRUST_PROXY + '，ALLOW_ORIGINS=' + origins + '）');
  }
  const dbFile = path.join(ROOT, 'data', 'db.json');
  if (fs.existsSync(dbFile) && !SKIP_SYNC) {
    const size = fs.statSync(dbFile).size;
    console.log('本地库 data/db.json ' + (size / 1024 / 1024).toFixed(1) + ' MB，将随目录一起上传（部署前会先合并线上数据）');
  }
  return { envFile, merged };
}

function runSync() {
  console.log('▶ 同步线上用户数据到本地库…');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'ops', 'sync-live.mjs')], {
    cwd: ROOT, stdio: 'inherit'
  });
  if (r.status !== 0) {
    console.error('✗ 同步失败，已中止部署（避免覆盖线上用户数据）');
    process.exit(1);
  }
}

async function deploy() {
  const raw = process.env.CODEBUDDY_MCP_CONFIG;
  if (!raw) throw new Error('缺少 CODEBUDDY_MCP_CONFIG，无法调用发布工具');
  const cfg = JSON.parse(raw);
  const cp = (cfg.mcpServers || {})['connector-proxy'];
  if (!cp) throw new Error('配置里没有 connector-proxy');
  const args = {
    action: 'deploy',
    directory: ROOT,
    language: 'node',
    port: Number(process.env.PORT || 8787),
    appName: '数海晴岸',
    domainPrefix: process.env.DOMAIN_PREFIX || 'math-vault-10141',
    userAskedToPublish: PUBLISH
  };
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'workbuddy_sites_deploy', arguments: args }
  });
  const res = await fetch(cp.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: cp.headers.Authorization,
      'X-WorkBuddy-MCP-Context': cp.headers['X-WorkBuddy-MCP-Context']
    },
    body
  });
  const text = await res.text();
  let out = '';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const d = JSON.parse(line.slice(6));
      const c = d.result && d.result.content && d.result.content[0];
      if (c && c.text) out = c.text;
      if (d.error) out = 'ERROR ' + JSON.stringify(d.error).slice(0, 300);
    } catch (_) {}
  }
  console.log('▶ 发布结果:', out.slice(0, 400) || text.slice(0, 300));
  if (!/成功|deployed|http/i.test(out) && res.status >= 400) throw new Error('发布失败 HTTP ' + res.status);
}

(async () => {
  const PREFLIGHT_ONLY = process.argv.includes('--preflight-only');
  preflight();
  if (PREFLIGHT_ONLY) {
    console.log('\n--preflight-only：只做配置检查，没有同步、没有上传。');
    return;
  }
  if (!PUBLISH) throw new Error('发布需要显式授权：加 --publish，或设置 USER_ASKED_TO_PUBLISH=1');
  if (!SKIP_SYNC) runSync();
  else {
    if (!ALLOW_NO_SYNC) throw new Error('禁止 --no-sync：同步会合并线上提交/用户数据。确实要跳过请显式设置 ALLOW_NO_SYNC=1');
    console.log('⚠ 已跳过线上同步（显式 ALLOW_NO_SYNC=1；仅用于确认线上无用户数据）');
  }
  await deploy();
})().catch((e) => { console.error('✗ 部署失败:', e.message); process.exit(1); });
