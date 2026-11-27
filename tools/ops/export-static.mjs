#!/usr/bin/env node
/**
 * 把题库导出成「静态数据包」，让 github.io 自己就能当后端。
 *
 *   node tools/ops/export-static.mjs            # 生成 public/data/（构建时会带进 docs/）
 *   node tools/ops/export-static.mjs --check    # 只报告体量，不写盘
 *
 * 产物（全部落在 public/data/，CI 构建 docs/ 时原样带过去）：
 *   meta.json            站点信息 + 标签树 + 统计（替代 /api/meta）
 *   list-<subject>.json  列表项（不含答案解析，替代 /api/problems?...）
 *   p/bucket-NN.json     详情分桶，每桶 250 题（替代 /api/problems/:code）
 *   manifest.json        版本号与桶索引，前端据此缓存
 *
 * 为什么从本地服务取列表：visibleProblem / excerptOf / levelOf 这些投影逻辑
 * 都在服务端，照抄一份必然漂移。所以起一个只读临时实例（用库的副本，避免把
 * 浏览量写进真库），把 /api/meta 与 /api/problems 原样抓下来，再按需补上
 * statement / hints / answer / solution（这几项服务端只在详情接口给）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const PORT = Number(process.env.EXPORT_PORT || 8971);
const BASE = 'http://127.0.0.1:' + PORT;
const CHECK_ONLY = process.argv.includes('--check');
const BUCKET_SIZE = Number(process.env.BUCKET_SIZE || 250);
const PAGE_SIZE = 50;      // 服务端 size 上限

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('临时实例没起来（端口 ' + PORT + '）');
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
  return r.json();
}

function writeJson(file, obj, pretty) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, pretty ? 1 : 0), 'utf8');
  return fs.statSync(file).size;
}

const mb = (n) => (n / 1e6).toFixed(2) + ' MB';

async function main() {
  if (!fs.existsSync(DB_FILE)) throw new Error('找不到 ' + DB_FILE);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amv-export-'));
  const tmpDb = path.join(tmpDir, 'db.json');
  fs.copyFileSync(DB_FILE, tmpDb);          // 只读副本：不污染真实浏览量

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      DB_FILE: tmpDb, PORT: String(PORT), HOST: '127.0.0.1',
      VIEW_FLUSH_MS: '3600000',             // 导出期间别刷盘
      DISABLE_SWEEP: '1'
    }),
    stdio: 'ignore'
  });

  let total = 0;
  try {
    await waitForServer();
    const meta = await getJson(BASE + '/api/meta');
    if (!meta.ok) throw new Error('meta 不 ok');
    const subjects = ['math', 'physics'];

    /* ---- 列表：按学科抓全量（服务端 size 上限 50，分页抓） ---- */
    const lists = {};
    for (const sub of subjects) {
      const first = await getJson(BASE + '/api/problems?subject=' + sub + '&size=' + PAGE_SIZE + '&page=1');
      const pages = first.pages || 1;
      const items = first.items.slice();
      for (let pg = 2; pg <= pages; pg++) {
        const r = await getJson(BASE + '/api/problems?subject=' + sub + '&size=' + PAGE_SIZE + '&page=' + pg);
        for (const it of r.items) items.push(it);
      }
      lists[sub] = items;
      console.log('  列表 ' + sub + '：' + items.length + ' 题（' + pages + ' 页）');
    }

    /* ---- 详情：从库里补 statement / hints / answer / solution ---- */
    const db = JSON.parse(fs.readFileSync(tmpDb, 'utf8'));
    const byCode = new Map(db.problems.map((p) => [p.code, p]));

    const detail = {};
    for (const sub of subjects) {
      for (const it of lists[sub]) {
        const raw = byCode.get(it.code);
        if (!raw) continue;
        detail[it.code] = {
          statement: raw.statement,
          hints: raw.hints || [],
          answer: raw.answer || '',
          solution: raw.solution || '',
          source: raw.source || '',
          createdAt: raw.createdAt || ''
        };
      }
    }

    /* ---- 版本号：列表规模 + 题库序号，数据一变就变 ---- */
    const ver = (function () {
      let h = 5381;
      const s = subjects.map((k) => k + ':' + lists[k].length).join(',') + '|' + (db.meta && db.meta.seq || 0);
      for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
      return h.toString(16) + '-' + s.length;
    })();

    const staticMeta = Object.assign({}, meta, {
      ok: true, v: ver,
      static: true,
      generatedAt: new Date().toISOString(),
      /* 静态包没有服务端能力：这些开关一律关掉，前端据此隐藏入口 */
      features: {
        analytics: false, collections: false, equivalentJudge: true,
        sprint: false, physics: true, physicsJudge: false,
        vocab: false, wrongbookManual: false, forum: false, auth: false, static: true
      },
      stats: Object.assign({}, meta.stats, {
        users: 0, solves: 0, posts: 0, pending: 0, feedback: 0
      })
    });

    if (CHECK_ONLY) {
      console.log('检查模式：列表 ' + mb(JSON.stringify(lists).length) + '，详情 ' + mb(JSON.stringify(detail).length));
      return;
    }

    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    total += writeJson(path.join(OUT_DIR, 'meta.json'), staticMeta, false);
    for (const sub of subjects) total += writeJson(path.join(OUT_DIR, 'list-' + sub + '.json'), lists[sub], false);

    /* 详情按编号排序后切成固定大小的桶，前端按编号定位 */
    const codes = Object.keys(detail).sort();
    const buckets = [];
    for (let i = 0; i < codes.length; i += BUCKET_SIZE) {
      const slice = codes.slice(i, i + BUCKET_SIZE);
      const obj = {};
      for (const c of slice) obj[c] = detail[c];
      const name = 'p/bucket-' + String(buckets.length).padStart(2, '0') + '.json';
      total += writeJson(path.join(OUT_DIR, name), { v: ver, items: obj }, false);
      buckets.push({ file: name, from: slice[0], to: slice[slice.length - 1], count: slice.length });
    }

    const manifest = {
      v: ver, generatedAt: staticMeta.generatedAt,
      counts: { total: codes.length, math: lists.math.length, physics: lists.physics.length },
      bucketSize: BUCKET_SIZE, buckets
    };
    total += writeJson(path.join(OUT_DIR, 'manifest.json'), manifest, true);

    console.log('静态数据包 → ' + path.relative(ROOT, OUT_DIR) + '（' + mb(total) + '，' + buckets.length + ' 个详情桶）');
    console.log('  版本号 ' + ver + '，数学 ' + lists.math.length + ' / 物理 ' + lists.physics.length);
  } finally {
    child.kill();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch((e) => { console.error('导出失败：' + e.message); process.exit(1); });
