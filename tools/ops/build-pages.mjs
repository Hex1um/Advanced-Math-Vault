#!/usr/bin/env node
/**
 * 生成 GitHub Pages 静态产物：public/ → docs/
 * 同时写入 docs/js/config.js，把接口地址指向后端。
 *
 * 用法：
 *   node tools/ops/build-pages.mjs                                    # 沿用已有 docs/js/config.js 里的地址
 *   API_BASE=https://api.example.com SHARECODE=xxxx node tools/ops/build-pages.mjs   # 换后端
 *
 * 关于 sharecode：它是托管网关的公开访问码，必然随前端发布（就在 docs/js/config.js 里），
 * 不是密钥；管理员密码才是密钥，且只走环境变量。这里为了避免「重建时把地址改回旧值」，
 * 未显式传参时沿用上一次生成的 docs/js/config.js，没有该文件才报错。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'docs');

const PREV_FILE = path.join(OUT, 'js', 'config.js');
function prevConfig() {
  try {
    const s = fs.readFileSync(PREV_FILE, 'utf8');
    const pick = (k) => {
      const m = new RegExp(k + "\\s*:\\s*[\"']([^\"']*)[\"']").exec(s);
      return m ? m[1] : '';
    };
    return { apiBase: pick('apiBase'), sharecode: pick('sharecode'), siteName: pick('siteName') };
  } catch (e) {
    return { apiBase: '', sharecode: '', siteName: '' };
  }
}
const prev = prevConfig();

/* 仓库内的 deploy.config.json 是「前端该指向哪个后端」的唯一真相。
   为什么不让 CI 的 env 说了算：apiBase 与 sharecode 必须成对，两处各自漂移过一次
   （env 指向新实例、分享码还是旧实例的，上线后全站 403；后来又因为两者不一致，
   构建时的连通性校验直接让 Pages 构建失败）。所以默认完全以文件为准，
   确实要临时换后端时用 FORCE_BACKEND_ENV=1 + API_BASE/SHARECODE。
   改完这个文件记得同时动一下会触发 pages.yml 的路径（如某个 public/ 文件）。 */
const FILE_CFG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy.config.json'), 'utf8')); }
  catch (e) { return {}; }
})();

const forceEnv = process.env.FORCE_BACKEND_ENV === '1';
const envBase = String(process.env.API_BASE || '').trim();
const envCode = String(process.env.SHARECODE || '').trim();
const useEnv = forceEnv || (!FILE_CFG.apiBase && !!envBase);

const API_BASE = (useEnv ? (envBase || FILE_CFG.apiBase) : FILE_CFG.apiBase) || prev.apiBase || 'https://math-vault-10141.app.workbuddy.host';
const SITE_NAME = process.env.SITE_NAME || FILE_CFG.siteName || prev.siteName || '数海晴岸';
const SHARECODE = (useEnv ? (envCode || FILE_CFG.sharecode) : FILE_CFG.sharecode) || prev.sharecode || '';
if (!SHARECODE) {
  console.error('缺少 SHARECODE：deploy.config.json 里没有，环境变量也没有（FORCE_BACKEND_ENV=1 时才用 env）。');
  process.exit(2);
}
if (!useEnv && envBase && envBase !== API_BASE) {
  console.log('[build-pages] 忽略环境变量里的 API_BASE（' + envBase + '），按 deploy.config.json 构建。');
  console.log('[build-pages] 真要换后端：FORCE_BACKEND_ENV=1 API_BASE=... SHARECODE=... node tools/ops/build-pages.mjs');
}

/* 上线前校验这对「地址 + 分享码」真的能用：v2.0.x 曾把分享码留成旧实例的，
   构建成功、Pages 也发布成功，但打开页面每个接口都 403。
   403/401 视为确定性错误直接拦；网络不可达只告警（CI 里可能连不上托管域名）。 */
if (process.env.SKIP_BACKEND_PROBE !== '1') {
  try {
    const url = API_BASE.replace(/\/+$/, '') + '/api/health?sharecode=' + encodeURIComponent(SHARECODE);
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) {
      console.error('✗ 后端拒绝了这对配置（HTTP ' + res.status + '）：' + API_BASE + ' 不认识分享码 ' + SHARECODE.slice(0, 4) + '••••');
      console.error('  改 deploy.config.json（或同时传 API_BASE / SHARECODE）后重试；确认要跳过校验用 SKIP_BACKEND_PROBE=1。');
      process.exit(3);
    }
    if (!res.ok) console.warn('[build-pages] 后端健康检查返回 ' + res.status + '，继续构建（可能正在部署）');
    else console.log('[build-pages] 后端连通性校验通过（' + API_BASE + '）');
  } catch (e) {
    console.warn('[build-pages] 后端连通性未校验：' + (e && e.message));
  }
}

/* 保留文件：构建产物里由脚本自己生成、public/ 里没有的东西 */
const KEEP_IN_OUT = new Set(['js/config.js', '404.html']);

function unlinkChecked(file, rel) {
  try {
    fs.unlinkSync(file);
  } catch (e) {
    console.error('  ! 删除失败 ' + rel + '：' + e.message);
    failed++;
  }
}

function walkRemove(dir, rel) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkRemove(p, rel + '/' + entry.name);
    else unlinkChecked(p, rel + '/' + entry.name);
  }
  try { fs.rmdirSync(dir); } catch (e) {
    console.error('  ! 删除目录失败 ' + rel + '：' + e.message);
    failed++;
  }
}

/* 递归同步：旧实现只比对顶层名字，public/js/views/ 里删掉的文件会永远留在 docs/
   里，Pages 上就成了「代码已经删了但旧文件还能被访问」。逐层递归比对，
   删除失败也不再被空 catch 吞掉（静默失败比报错更难查）。 */
function syncInto(srcDir, outDir, rel) {
  const prefix = rel || '';
  fs.mkdirSync(outDir, { recursive: true });
  const srcNames = new Set(fs.readdirSync(srcDir));
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    const relPath = prefix ? prefix + '/' + entry.name : entry.name;
    const p = path.join(outDir, entry.name);
    if (KEEP_IN_OUT.has(relPath)) continue;
    if (!srcNames.has(entry.name)) {
      if (entry.isDirectory()) walkRemove(p, relPath);
      else unlinkChecked(p, relPath);
      continue;
    }
    const srcChild = path.join(srcDir, entry.name);
    const srcIsDir = fs.statSync(srcChild).isDirectory();
    if (entry.isDirectory() && srcIsDir) {
      syncInto(srcChild, p, relPath);
    } else if (entry.isDirectory() !== srcIsDir) {
      // 同名但类型变了：先删掉旧的，交给 copyDir 重新建
      if (entry.isDirectory()) walkRemove(p, relPath);
      else unlinkChecked(p, relPath);
    }
  }
}

/* 缓存串统一由 package.json 的 version 注入，避免 public/index.html 手写的
   ?v=1.2.1 落后于真实版本，发版后浏览器还在用旧 JS。
   只改 ./ 下的本地资源，vendor/ 里的第三方静态文件保持原样。 */
function injectVersion(file, version) {
  if (!fs.existsSync(file)) return 0;
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(
    /((?:src|href)="\.\/(?!vendor\/)[^"]*?\.(?:js|css))(?:\?v=[^"&]*)?"/g,
    '$1?v=' + version + '"'
  );
  if (after !== before) fs.writeFileSync(file, after, 'utf8');
  return (after.match(/\?v=/g) || []).length;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

let failed = 0;
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = process.env.BUILD_VERSION || PKG.version || '0.0.0';

syncInto(SRC, OUT);
copyDir(SRC, OUT);

fs.writeFileSync(path.join(OUT, 'js', 'config.js'), `/* 由 tools/ops/build-pages.mjs 生成：GitHub Pages 上指到后端 */
window.MV_CONFIG = {
  apiBase: ${JSON.stringify(API_BASE)},
  sharecode: ${JSON.stringify(SHARECODE)},
  siteName: ${JSON.stringify(SITE_NAME)}
};
`, 'utf8');

// Pages 上不需要 404 兜底页，但保留一个说明，避免直接访问子路径时一片空白
fs.writeFileSync(path.join(OUT, '404.html'), `<!DOCTYPE html><meta charset="utf-8"><title>页面不存在</title>
<p style="font-family:system-ui;padding:40px">这个地址没有内容，回到 <a href="./">数海晴岸</a>。</p>
`, 'utf8');

const tagged = injectVersion(path.join(OUT, 'index.html'), VERSION);
if (failed) {
  console.error('✗ 同步 docs/ 时有 ' + failed + ' 个文件/目录删除失败，产物可能夹带旧文件');
  process.exit(1);
}

let files = 0;
(function count(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) count(p); else files += 1;
  }
})(OUT);

console.log('已生成 docs/：' + files + ' 个文件（缓存串 ?v=' + VERSION + '，共 ' + tagged + ' 处）');
console.log('  apiBase  = ' + API_BASE);
console.log('  sharecode= ' + (SHARECODE ? SHARECODE.slice(0, 4) + '••••' : '(无)'));
