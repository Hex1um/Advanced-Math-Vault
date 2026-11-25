#!/usr/bin/env node
/**
 * .env 解析自测：不覆盖已有变量、引号、注释、续行、变量展开
 *
 *   node tools/verify/env-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const { loadDotEnv, parse } = require(path.join(ROOT, 'lib', 'env.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const tmp = path.join(os.tmpdir(), 'mv-env-test-' + Date.now() + '.env');
fs.writeFileSync(tmp, [
  '# 注释行',
  'PLAIN=hello',
  'QUOTED="带 空格 的值"',
  'SINGLE=\'单引号\'',
  'WITH_COMMENT=abc # 行内注释',
  'MULTI=第一行\\',
  '第二行',
  'REF=${PLAIN}-suffix',
  'EMPTY='
].join('\n'), 'utf8');

console.log('\n[1] 解析');
const parsed = parse(fs.readFileSync(tmp, 'utf8'), { PLAIN: 'hello' });
ok('普通键值', parsed.PLAIN === 'hello');
ok('双引号保留空格', parsed.QUOTED === '带 空格 的值');
ok('单引号原样', parsed.SINGLE === '单引号');
ok('行内注释被去掉', parsed.WITH_COMMENT === 'abc', parsed.WITH_COMMENT);
ok('反斜杠续行合并', parsed.MULTI === '第一行第二行', parsed.MULTI);
ok('${VAR} 展开', parsed.REF === 'hello-suffix', parsed.REF);
ok('空值保留为空串', parsed.EMPTY === '');

console.log('\n[2] 加载策略');
const env = { PLAIN: 'already' };
const r = loadDotEnv(tmp, { env });
ok('已存在的变量不被覆盖', env.PLAIN === 'already' && r.kept.includes('PLAIN'));
ok('新变量写入环境', env.QUOTED === '带 空格 的值' && r.load.includes('QUOTED'));
ok('文件不存在时安全返回', loadDotEnv(tmp + '.nope', { env }).load.length === 0);

try { fs.unlinkSync(tmp); } catch (e) {}
console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
