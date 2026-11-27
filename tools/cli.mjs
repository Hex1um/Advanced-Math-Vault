#!/usr/bin/env node
/**
 * 脚本索引：把「目录里散着 40 多个文件名」收成两条命令
 *
 *   npm run ops backup                 # → node tools/ops/backup-db.mjs
 *   npm run ops deploy --publish       # → node tools/ops/deploy.mjs --publish
 *   npm run import problems data/batch-05.json --verify
 *   node tools/cli.mjs                 # 不传参就把下面这张表打出来
 *
 * 为什么要有它：
 *   package.json 里原来有 49 个 scripts，其中一半是「一个脚本一条命令」的脚手架，
 *   名字还重叠（verify:physics / check:physics / check:physics-gate）。
 *   真正需要天天敲的其实只有 test / lint / check:all，其余都是偶尔用一次的运维动作，
 *   现在按用途分两条命令，加一个子命令即可。
 *
 * 注意：已经被 CI 工作流直接调用的名字（check:store、check:physics-gate 等）在
 * package.json 里仍然保留 —— 改 .github/workflows/* 需要带 workflow scope 的凭据，
 * 这里不擅自删掉会让 CI 变红的名字。
 *
 * 新增脚本的规矩：把文件放进 tools/{ops,import,verify}/，再在下面这张表加一行，
 * 不要在 package.json 里再开一条新命令。
 */
'use strict';

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 子命令 → 脚本。键是「组 + 动词」，值是要跑的脚本路径（相对仓库根）。 */
const COMMANDS = {
  // 运维：部署、备份、账号、数据迁移与修复
  'ops deploy': 'tools/ops/deploy.mjs',
  'ops backup': 'tools/ops/backup-db.mjs',
  'ops admin': 'tools/ops/create-admin.mjs',
  'ops build-pages': 'tools/ops/build-pages.mjs',
  'ops check-pages': 'tools/ops/check-pages.mjs',
  'ops sync': 'tools/ops/sync-live.mjs',
  'ops pull-db': 'tools/ops/pull-live-db.mjs',
  'ops export-batch': 'tools/ops/export-batch.mjs',
  'ops migrate-sqlite': 'tools/ops/migrate-json-to-sqlite.mjs',
  'ops merge-instances': 'tools/ops/merge-instances.mjs',
  'ops merge-users': 'tools/ops/merge-users-from.mjs',
  'ops repair-delims': 'tools/ops/repair-missing-delims.mjs',
  'ops repair-problems': 'tools/ops/repair-problems.mjs',
  'ops prune': 'tools/ops/prune-vault.mjs',

  // 数据录入：批量导入、标签迁移、题库构建
  'import problems': 'tools/import/import-problems.mjs',
  'import gate': 'tools/import/gate.mjs',
  'import tags': 'tools/import/migrate-tags.mjs',
  'import contest': 'tools/import/import-contest.mjs',
  'import hust': 'tools/import/import-hust.mjs',
  'import hust-pdf': 'tools/import/import-hust-pdf.mjs',
  'import calc-pack': 'tools/import/build-calculus-pack.mjs',
  'import split-exams': 'tools/import/split-exams.mjs',
  'import notation': 'tools/import/normalize-notation.mjs',
  'import fix-latex': 'tools/import/fix-latex.mjs',

  // 体检：人工看的那种（CI 里跑的是 package.json 里的 check:*）
  'check audit': 'tools/verify/audit-all.mjs',
  'check diagrams': 'tools/diagrams/make-svg.mjs',
  'check ocr-eval': 'tools/verify/eval-ocr.mjs'
};

const argv = process.argv.slice(2);
const groups = {};

for (const key of Object.keys(COMMANDS)) {
  const [group, verb] = key.split(' ');
  (groups[group] = groups[group] || []).push(verb);
}

function usage(code) {
  const lines = [
    '数海晴岸 · 脚本索引',
    '',
    '  npm run ops <动词> [...]       运维（会写库 / 会发版，注意参数）',
    '  npm run import <动词> [...]     录题与数据整理',
    '  node tools/cli.mjs check <动词> 人工体检（CI 跑的是 npm test）',
    ''
  ];
  for (const [group, verbs] of Object.entries(groups)) {
    lines.push('  ' + group + ': ' + verbs.join(' · '));
  }
  lines.push('', '  例：npm run ops deploy --publish');
  lines.push('      npm run import problems data/batch-05.json --verify');
  console.log(lines.join('\n'));
  process.exit(code);
}

if (!argv.length || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') usage(0);

const group = argv[0];
/* `npm run ops` / `npm run ops --list` / `npm run ops list` 都当成「列出这组能干什么」 */
const wantsList = argv[1] === '--list' || argv[1] === 'list' || !argv[1];
if (wantsList && groups[group]) {
  console.log(group + ': ' + groups[group].join(' · '));
  process.exit(0);
}
if (wantsList && !groups[group]) usage(2);

const key = group + ' ' + argv[1];
const script = COMMANDS[key];
if (!script) {
  console.error('没有这个子命令：' + [group, argv[1]].filter(Boolean).join(' '));
  console.error('可用：' + Object.keys(COMMANDS).join(', '));
  process.exit(2);
}

/* 参数原样透传：`npm run ops deploy --publish` 里 --publish 会落在 argv.slice(2)。
   stdio 继承，让子脚本的交互式提示、颜色、进度条照常工作。 */
const res = spawnSync(process.execPath, [path.join(ROOT, script)].concat(argv.slice(2)), {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env
});
process.exit(res.status === null ? 1 : res.status);
