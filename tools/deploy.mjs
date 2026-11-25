#!/usr/bin/env node
/**
 * 安全部署：先跑 sync-live 把线上用户/帖子合并进本地库，再上传覆盖。
 *
 * 2026-11-24 事故复盘：直接用本地 db.json 部署，会把线上用户的帖子和经验一起覆盖掉。
 * 以后一律用 `node tools/deploy.mjs` 发布，不要手工调发布工具。
 *
 * 用法：
 *   node tools/deploy.mjs              # 同步 + 部署
 *   node tools/deploy.mjs --no-sync    # 跳过同步（仅当确认线上无用户数据时）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SKIP_SYNC = process.argv.includes('--no-sync');
const PUBLISH = process.argv.includes('--publish') || process.env.USER_ASKED_TO_PUBLISH === '1';

function runSync() {
  console.log('▶ 同步线上用户数据到本地库…');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'sync-live.mjs')], {
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
    domainPrefix: 'math-vault-10141',
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
  if (!PUBLISH) throw new Error('发布需要显式授权：加 --publish，或设置 USER_ASKED_TO_PUBLISH=1');
  if (!SKIP_SYNC) runSync();
  else console.log('⚠ 已跳过线上同步（确保线上确实没有用户数据）');
  await deploy();
})().catch((e) => { console.error('✗ 部署失败:', e.message); process.exit(1); });
