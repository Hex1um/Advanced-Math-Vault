#!/usr/bin/env node
/**
 * Pages 产物自检：build-pages.mjs 跑完之后、上传 Artifact 之前执行。
 *
 *   node tools/ops/check-pages.mjs
 *
 * 查三件事（都是「构建成功但线上白屏」的常见原因）：
 *   1. docs/index.html 存在且非空；
 *   2. 页面里每个本地 <script src> / <link href> 指向的文件都真的在 docs/ 里；
 *   3. docs/js/config.js 能被解析，且 apiBase / sharecode 都非空。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs');
const INDEX = path.join(DOCS, 'index.html');

let fail = 0;
const bad = (msg) => { fail++; console.error('  ✗ ' + msg); };
const good = (msg) => console.log('  ✓ ' + msg);

if (!fs.existsSync(INDEX)) {
  console.error('✗ 缺少 docs/index.html：build-pages.mjs 没跑成功？');
  process.exit(1);
}
const html = fs.readFileSync(INDEX, 'utf8');
good('docs/index.html 存在（' + (html.length / 1024).toFixed(1) + ' KB）');

const refs = [];
const re = /(?:src|href)="([^"]+)"/g;
let m;
while ((m = re.exec(html)) !== null) {
  const url = m[1];
  if (/^(https?:|data:|mailto:|#)/i.test(url)) continue;
  refs.push(url.split('?')[0].split('#')[0]);
}
let missing = 0;
for (const rel of [...new Set(refs)]) {
  if (!rel || rel === '/' || rel.endsWith('/')) continue;
  const file = path.join(DOCS, rel.replace(/^\.?\//, ''));
  if (!fs.existsSync(file)) { missing++; bad('引用的文件不存在：' + rel); }
}
if (!missing) good('页面引用的 ' + new Set(refs).size + ' 个本地资源全部存在');

const cfgFile = path.join(DOCS, 'js', 'config.js');
if (!fs.existsSync(cfgFile)) {
  bad('缺少 docs/js/config.js（前端拿不到接口地址）');
} else {
  const sandbox = { window: {} };
  try {
    vm.runInNewContext(fs.readFileSync(cfgFile, 'utf8'), sandbox, { timeout: 1000 });
    const cfg = sandbox.window.MV_CONFIG || {};
    if (cfg.staticData === true) {
      /* 纯静态模式：没有后端，apiBase / sharecode 本来就该是空的，
         改为校验「静态数据包」是否齐全（meta / 列表 / 桶索引） */
      good('config.js 为静态模式（staticData=true，不依赖后端）');
      for (const f of ['data/meta.json', 'data/manifest.json', 'data/list-math.json', 'data/list-physics.json']) {
        if (fs.existsSync(path.join(DOCS, f))) good('静态包 ' + f + ' 存在');
        else bad('静态模式下缺少 ' + f);
      }
      try {
        const man = JSON.parse(fs.readFileSync(path.join(DOCS, 'data', 'manifest.json'), 'utf8'));
        const n = (man.counts && man.counts.total) || 0;
        if (n > 0 && Array.isArray(man.buckets) && man.buckets.length) good('静态包版本 ' + man.v + '，共 ' + n + ' 题 / ' + man.buckets.length + ' 桶');
        else bad('manifest.json 内容不完整');
      } catch (e) { bad('manifest.json 解析失败：' + e.message); }
    } else {
      if (!String(cfg.apiBase || '').trim()) bad('config.js 的 apiBase 为空');
      else good('config.js 可解析，apiBase=' + cfg.apiBase);
      if (!String(cfg.sharecode || '').trim()) bad('config.js 的 sharecode 为空');
      else good('config.js sharecode 已写入');
    }
  } catch (e) {
    bad('config.js 语法错误：' + e.message);
  }
}

/* PWA：manifest 必须可解析，sw.js 必须在产物里（否则离线/安装提示永远不出现） */
const mf = path.join(DOCS, 'manifest.json');
if (!fs.existsSync(mf)) {
  bad('缺少 docs/manifest.json');
} else {
  try {
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    if (!m.name || !m.start_url) bad('manifest 缺少 name / start_url');
    else good('manifest.json 可解析（' + m.short_name + '）');
    const icons = Array.isArray(m.icons) ? m.icons : [];
    const missingIcon = icons.find((i) => !fs.existsSync(path.join(DOCS, String(i.src || '').replace(/^\.\//, ''))));
    if (missingIcon) bad('manifest 图标不存在：' + missingIcon.src);
    else if (icons.length) good('manifest 图标齐全（' + icons.length + ' 个）');
  } catch (e) {
    bad('manifest.json 解析失败：' + e.message);
  }
}
const sw = path.join(DOCS, 'sw.js');
if (!fs.existsSync(sw)) bad('缺少 docs/sw.js（Service Worker）');
else if (!/addEventListener\('fetch'/.test(fs.readFileSync(sw, 'utf8'))) bad('sw.js 里没有 fetch 处理逻辑');
else good('sw.js 存在且带 fetch 处理');

console.log(fail ? '\n✗ Pages 产物自检未通过（' + fail + ' 项）' : '\n✓ Pages 产物自检通过');
process.exit(fail ? 1 : 0);
