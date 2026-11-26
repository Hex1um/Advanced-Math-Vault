#!/usr/bin/env node
/**
 * 安全部署：先跑 sync-live 把线上用户/帖子合并进本地库，再上传覆盖。
 *
 * 2026-11-24 事故复盘：直接用本地 db.json 部署，会把线上用户的帖子和经验一起覆盖掉。
 * 以后一律用 `node tools/ops/deploy.mjs` 发布，不要手工调发布工具。
 *
 * 用法：
 *   node tools/ops/deploy.mjs                     # 检查 → 门禁 → 备份 → 同步 → 部署
 *   node tools/ops/deploy.mjs --preflight-only    # 只做配置与库状态检查（不上传）
 *   node tools/ops/deploy.mjs --skip-checks       # 跳过 check:katex / check:store（不推荐）
 *   node tools/ops/deploy.mjs --no-sync           # 跳过同步（需 ALLOW_NO_SYNC=1）
 *
 * 发布结果判定（v1.3.1 的坑）：
 *   旧代码 `if (!/成功|deployed|http/i.test(out) && res.status >= 400)` 用 && 连接，
 *   HTTP 200 但响应体里写着错误也被当成成功。现在解析 JSON-RPC 的 result/error，
 *   再叠加 HTTP 状态与失败关键词，任一命中就判失败并打印完整响应。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const require = createRequire(import.meta.url);
const { parse: parseEnv } = require(path.join(ROOT, 'lib', 'env.js'));

const argv = process.argv.slice(2);
const hasFlag = (n) => argv.includes('--' + n);

/* 部署凭据的来源，按优先级：
     1. shell 里已显式传入的环境变量（最高，不会被覆盖）
     2. ~/.math-vault-deploy.env（项目目录之外，推荐）
     3. 项目内的 .env（会被随目录上传到实例，**不推荐**放口令，仅为兼容保留）
   之所以还要读 .env：用户可能已经把凭据写在里面，此时不该因为「找不到外部文件」就报缺少变量。 */
const CRED_FILE = process.env.DEPLOY_CRED_FILE
  || path.join(process.env.USERPROFILE || process.env.HOME || '', '.math-vault-deploy.env');
const CRED_KEYS = ['SHARECODE', 'ADMIN_USER', 'ADMIN_PASS', 'ADMIN_TOKEN', 'BASE', 'API_BASE'];

function readEnvFile(file) {
  try { return file && fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8'), {}) : {}; }
  catch (e) { return {}; }
}

function loadCreds() {
  const sources = [];
  for (const [file, required] of [[CRED_FILE, false], [path.join(ROOT, '.env'), true]]) {
    const parsed = readEnvFile(file);
    const applied = [];
    for (const k of CRED_KEYS) {
      const v = String(parsed[k] || '').trim();
      if (!v || String(process.env[k] || '').trim()) continue;
      process.env[k] = v;
      applied.push(k);
    }
    if (applied.length) sources.push({ file: file, keys: applied, inRepo: required });
  }
  return { sources: sources };
}

const SKIP_SYNC = hasFlag('no-sync');
const ALLOW_NO_SYNC = process.env.ALLOW_NO_SYNC === '1';
const PUBLISH = hasFlag('publish') || process.env.USER_ASKED_TO_PUBLISH === '1';
const PREFLIGHT_ONLY = hasFlag('preflight-only');
const SKIP_CHECKS = hasFlag('skip-checks');

const DB_FILE = path.join(ROOT, 'data', 'db.json');
const SQLITE_FILE = path.join(ROOT, 'data', 'db.sqlite');
const ANCHOR_FILE = path.join(ROOT, '.deploy-anchor');

function loadEnv() {
  const envFile = path.join(ROOT, '.env');
  const fileEnv = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8'), process.env) : {};
  return { envFile, merged: Object.assign({}, fileEnv, process.env) };
}

/* 可追溯性：曾经出现过「线上跑的版本号在仓库里查不到」，事后无法定位代码状态。
   发布前把 commit 写进 data/build-info.json，/api/health 会带出来；
   同时要求工作区干净——带未提交改动发布，等于又制造一份「线上有、仓库没有」的代码。 */
const ALLOW_DIRTY = process.env.ALLOW_DIRTY === '1';

function gitOut(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

function gitState() {
  const commit = gitOut(['rev-parse', '--short=12', 'HEAD']) || '';
  const dirtyRaw = gitOut(['status', '--porcelain']);
  return { commit, dirty: !!dirtyRaw, dirtyFiles: dirtyRaw ? dirtyRaw.split('\n').filter(Boolean) : [] };
}

function checkGit() {
  const g = gitState();
  if (!g.commit) {
    console.log('  ⚠ 读不到 git commit（不是 git 仓库？），build-info 里只会写时间戳');
  }
  if (g.dirty && !ALLOW_DIRTY) {
    console.error('  ✗ 工作区有未提交改动 ' + g.dirtyFiles.length + ' 处，拒绝发布：');
    g.dirtyFiles.slice(0, 10).forEach((f) => console.error('      ' + f));
    if (g.dirtyFiles.length > 10) console.error('      …共 ' + g.dirtyFiles.length + ' 处');
    console.error('    先 commit，或确实要发未提交状态时显式 ALLOW_DIRTY=1。');
    return { ok: false, git: g };
  }
  return { ok: true, git: g };
}

function writeBuildInfo(git) {
  const f = path.join(ROOT, 'data', 'build-info.json');
  const info = {
    version: (() => {
      try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch (e) { return ''; }
    })(),
    commit: git.commit,
    dirty: git.dirty,
    builtAt: new Date().toISOString()
  };
  fs.writeFileSync(f, JSON.stringify(info, null, 2), 'utf8');
  return info;
}

function dbStatus() {
  const out = { json: null, sqlite: null };
  if (fs.existsSync(DB_FILE)) {
    const size = fs.statSync(DB_FILE).size;
    const st = { file: DB_FILE, size, mb: (size / 1024 / 1024).toFixed(1), ok: false, counts: {} };
    try {
      const j = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      st.ok = true;
      for (const k of ['problems', 'users', 'posts', 'submissions', 'feedbacks']) {
        st.counts[k] = Array.isArray(j[k]) ? j[k].length : 0;
      }
      st.pending = (j.problems || []).filter((p) => p.status === 'pending').length;
    } catch (e) {
      st.error = e.message;
    }
    out.json = st;
  }
  if (fs.existsSync(SQLITE_FILE)) {
    const size = fs.statSync(SQLITE_FILE).size;
    const st = { file: SQLITE_FILE, size, mb: (size / 1024 / 1024).toFixed(1), ok: false, counts: {} };
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(SQLITE_FILE);
      try {
        const row = db.prepare('PRAGMA quick_check').get();
        st.ok = String(row && (row.quick_check !== undefined ? row.quick_check : Object.values(row)[0])).toLowerCase() === 'ok';
        for (const t of ['problems', 'users', 'posts', 'submissions', 'feedbacks']) {
          st.counts[t] = Number(db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n);
        }
      } finally { try { db.close(); } catch (e) {} }
    } catch (e) {
      st.error = e.message;
    }
    out.sqlite = st;
  }
  return out;
}

function preflight() {
  const { envFile, merged } = loadEnv();
  const warnings = [];
  const errors = [];

  if (!fs.existsSync(envFile) && !process.env.TRUST_PROXY && !process.env.ALLOW_ORIGINS) {
    warnings.push('没有 .env，也没有 TRUST_PROXY / ALLOW_ORIGINS：线上所有用户会共用代理 IP 的限流桶，且任何站点都能跨域调接口。');
    warnings.push('建议：cp .env.production.example .env 填好后再部署。');
  }
  if (!/^(1|true|yes|on)$/i.test(String(merged.TRUST_PROXY || ''))) {
    warnings.push('TRUST_PROXY 未开启：如果线上在反代后面，登录/AI/投稿的限流会按代理 IP 合并计算。');
  }
  const origins = String(merged.ALLOW_ORIGINS || '*');
  if (origins.trim() === '*') warnings.push('ALLOW_ORIGINS 仍是 *：建议改成 https://hex1um.github.io。');

  // 实例绑定指纹：v1.3.1 曾因为换目录克隆触发平台新建实例，旧实例的密码与提交全部失联
  const anchor = String(merged.DEPLOY_INSTANCE_ID || '').trim()
    || (fs.existsSync(ANCHOR_FILE) ? fs.readFileSync(ANCHOR_FILE, 'utf8').trim() : '');
  if (!anchor) {
    warnings.push('没有 DEPLOY_INSTANCE_ID 或 .deploy-anchor：换目录/重新克隆时可能被平台当成新实例，'
      + '导致旧实例的管理员密码与用户提交失联。建议把实例域名写入 .deploy-anchor。');
  }

  const db = dbStatus();
  if (!db.json && !db.sqlite) errors.push('data/ 下既没有 db.json 也没有 db.sqlite，无库可部署');
  if (db.json && !db.json.ok) errors.push('data/db.json 无法解析：' + db.json.error);
  if (db.sqlite && !db.sqlite.ok) errors.push('data/db.sqlite 完整性检查未通过：' + (db.sqlite.error || 'quick_check != ok'));

  console.log('▶ 部署前检查');
  console.log('  配置：TRUST_PROXY=' + (merged.TRUST_PROXY || '(未设)') + '  ALLOW_ORIGINS=' + origins
    + '  实例指纹=' + (anchor || '(无)'));
  for (const [k, st] of [['JSON  ', db.json], ['SQLite', db.sqlite]]) {
    if (!st) { console.log('  ' + k + '：不存在'); continue; }
    const counts = Object.entries(st.counts).map(([n, c]) => n + '=' + c).join(' ');
    console.log('  ' + k + '：' + st.mb + ' MB  ' + (st.ok ? '校验通过' : '校验失败') + '  ' + counts
      + (st.pending !== undefined ? '  待审=' + st.pending : ''));
  }
  for (const w of warnings) console.log('  ⚠ ' + w);
  for (const e of errors) console.log('  ✗ ' + e);
  if (!warnings.length && !errors.length) console.log('  ✓ 全部通过');
  return { ok: errors.length === 0, db, merged };
}

function runNode(script, args, title) {
  console.log('▶ ' + title + '…');
  const r = spawnSync(process.execPath, [path.join(ROOT, script)].concat(args || []), {
    cwd: ROOT, stdio: 'inherit'
  });
  return r.status === 0;
}

function runGates() {
  if (SKIP_CHECKS) {
    console.log('⚠ 已跳过 check:katex / check:store（--skip-checks）');
    return true;
  }
  if (!runNode('tools/verify/check-katex.mjs', ['--max-fail=0'], '题库 KaTeX 门禁')) return false;
  if (!runNode('tools/verify/store-test.mjs', [], '存储层增量落盘自测')) return false;
  return true;
}

const runBackup = (label) => runNode('tools/ops/backup-db.mjs', ['--label', label], '部署前热备份（' + label + '）');

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
  let rpcError = null;
  let isError = false;
  for (const line of text.split('\n')) {
    const payload = line.startsWith('data: ') ? line.slice(6) : (line.trim().startsWith('{') ? line : '');
    if (!payload) continue;
    let d;
    try { d = JSON.parse(payload); } catch (e) { continue; }
    if (d.error) rpcError = typeof d.error === 'string' ? d.error : JSON.stringify(d.error).slice(0, 300);
    const r = d.result;
    if (r && r.isError) isError = true;
    const c = r && r.content && r.content[0];
    if (c && c.text) out = String(c.text);
  }
  const failure = res.status >= 400 || !!rpcError || isError
    || /\b(error|failed|exception)\b|失败/i.test(out)
    || !out.trim();
  if (failure) {
    throw new Error('发布失败（HTTP ' + res.status + '）：'
      + String(rpcError || out || text).slice(0, 600));
  }
  console.log('▶ 发布结果: ' + out.slice(0, 400));
}

(async () => {
  const creds = loadCreds();
  const pre = preflight();
  const gitCheck = checkGit();
  console.log('▶ 代码状态：' + (gitCheck.git.commit || '(无 git)')
    + (gitCheck.git.dirty ? ' + ' + gitCheck.git.dirtyFiles.length + ' 处未提交改动' : ' 干净'));
  if (creds.sources.length) {
    creds.sources.forEach(function (s) {
      console.log('▶ 部署凭据：' + s.file + ' → ' + s.keys.join('/')
        + (s.inRepo ? '  ⚠ 凭据写在仓库内的 .env，会随目录上传到实例，建议改放到 ~/.math-vault-deploy.env' : ''));
    });
  } else {
    console.log('▶ 部署凭据：未在 ' + CRED_FILE + ' 或 .env 中找到，需要 SHARECODE 与 ADMIN_PASS 由环境变量传入');
  }
  const gatesOk = runGates();
  if (PREFLIGHT_ONLY) {
    console.log('\n--preflight-only：只做检查，没有备份、没有同步、没有上传。'
      + (pre.ok && gatesOk && gitCheck.ok ? '' : '\n✗ 检查未通过，修正后再部署'));
    if (!pre.ok || !gatesOk || !gitCheck.ok) process.exit(1);
    return;
  }
  if (!pre.ok) throw new Error('部署前检查未通过，已中止');
  if (!gitCheck.ok) throw new Error('工作区不干净，已中止（确需发布未提交状态请设 ALLOW_DIRTY=1）');
  if (!gatesOk) throw new Error('门禁未通过，已中止（确需跳过请加 --skip-checks）');
  if (!runBackup('pre-deploy')) throw new Error('部署前备份失败，已中止');
  if (!PUBLISH) throw new Error('发布需要显式授权：加 --publish，或设置 USER_ASKED_TO_PUBLISH=1');

  if (!SKIP_SYNC) runSync();
  else {
    if (!ALLOW_NO_SYNC) throw new Error('禁止 --no-sync：同步会合并线上提交/用户数据。确实要跳过请显式设置 ALLOW_NO_SYNC=1');
    console.log('⚠ 已跳过线上同步（显式 ALLOW_NO_SYNC=1；仅用于确认线上无用户数据）');
  }
  const info = writeBuildInfo(gitCheck.git);
  console.log('▶ build-info：' + info.version + ' @ ' + (info.commit || '(unknown)'));
  await deploy();
})().catch((e) => { console.error('✗ 部署失败:', e.message); process.exit(1); });
