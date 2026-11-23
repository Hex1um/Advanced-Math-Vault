#!/usr/bin/env node
/**
 * 生成 GitHub Pages 静态产物：public/ → docs/
 * 同时写入 docs/js/config.js，把接口地址指向后端。
 *
 * 用法：
 *   node tools/build-pages.mjs
 *   API_BASE=https://your-api.example.com SHARECODE=xxxx node tools/build-pages.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'docs');

const API_BASE = process.env.API_BASE || 'https://math-vault-10141.app.workbuddy.host';
const SHARECODE = process.env.SHARECODE || 'Q6CZHVVW3K';

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
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

rmrf(OUT);
copyDir(SRC, OUT);

fs.writeFileSync(path.join(OUT, 'js', 'config.js'), `/* 由 tools/build-pages.mjs 生成：GitHub Pages 上指到后端 */
window.MV_CONFIG = {
  apiBase: ${JSON.stringify(API_BASE)},
  sharecode: ${JSON.stringify(SHARECODE)},
  siteName: '高数好题收藏室'
};
`, 'utf8');

// Pages 上不需要 404 兜底页，但保留一个说明，避免直接访问子路径时一片空白
fs.writeFileSync(path.join(OUT, '404.html'), `<!DOCTYPE html><meta charset="utf-8"><title>页面不存在</title>
<p style="font-family:system-ui;padding:40px">这个地址没有内容，回到 <a href="./">高数好题收藏室</a>。</p>
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
console.log('  sharecode= ' + (SHARECODE ? SHARECODE : '(无)'));
