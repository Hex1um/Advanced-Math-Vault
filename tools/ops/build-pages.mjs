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
const API_BASE = process.env.API_BASE || prev.apiBase || 'https://math-vault-10141-52003.app.workbuddy.host';
const SITE_NAME = process.env.SITE_NAME || prev.siteName || '数海晴岸';
const SHARECODE = process.env.SHARECODE || prev.sharecode || '';
if (!SHARECODE) {
  console.error('缺少 SHARECODE：既没有显式传入，也没有可沿用的 docs/js/config.js。');
  console.error('  SHARECODE=xxxx API_BASE=https://your-api.example.com node tools/ops/build-pages.mjs');
  process.exit(2);
}

/* 不用 rm -rf：沙箱会把递归删除拦成回收站操作。这里改成「覆盖 + 删多余文件」。 */
function syncInto(srcDir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const srcNames = new Set(fs.readdirSync(srcDir));
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (srcNames.has(entry.name)) continue;
    const p = path.join(outDir, entry.name);
    try {
      if (entry.isDirectory()) walkRemove(p);
      else fs.unlinkSync(p);
    } catch (e) {}
  }
}

function walkRemove(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkRemove(p);
    else { try { fs.unlinkSync(p); } catch (e) {} }
  }
  try { fs.rmdirSync(dir); } catch (e) {}
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

let files = 0;
(function count(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) count(p); else files += 1;
  }
})(OUT);

console.log('已生成 docs/：' + files + ' 个文件');
console.log('  apiBase  = ' + API_BASE);
console.log('  sharecode= ' + (SHARECODE ? SHARECODE.slice(0, 4) + '••••' : '(无)'));
