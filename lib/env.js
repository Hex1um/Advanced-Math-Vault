/**
 * 极简 .env 加载器（零依赖）
 *
 * 托管平台多数已经有环境变量面板，但「把整个目录上传后直接 node server.js」
 * 这类部署没有面板，只能靠目录里的 .env。这里只做最保守的解析：
 *   - 已存在的 process.env 一律不覆盖（命令行/平台面板优先）
 *   - 支持 KEY=VALUE、# 注释、单双引号、行尾 \ 续行
 *   - 值里的 ${VAR} 会用当前环境展开
 *
 * 注意：.env 绝不能提交（.gitignore 已忽略，只提交 .env.example）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

function unquote(raw) {
  const s = String(raw).trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    const body = s.slice(1, -1);
    return s[0] === '"' ? body.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"') : body;
  }
  // 未加引号时去掉行内注释（前面至少一个空格）
  return s.replace(/\s+#.*$/, '').trim();
}

function expand(value, env) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => (env[name] !== undefined ? env[name] : ''));
}

function parse(text, env) {
  const out = {};
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let pending = '';
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!pending && /^\s*#/.test(line)) continue;
    if (!pending && !line.trim()) continue;
    if (/\\\s*$/.test(line)) { pending += line.replace(/\\\s*$/, ''); continue; }
    line = pending + line;
    pending = '';
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = expand(unquote(m[2]), env);
  }
  return out;
}

/**
 * 加载 .env 到 process.env。
 * @param {string} [file] 文件路径，默认仓库根的 .env
 * @param {{override?: boolean, env?: object, log?: Function}} [opts]
 * @returns {{load: string[], kept: string[]}} load=本次写入的键，kept=已存在而跳过的键
 */
function loadDotEnv(file, opts) {
  const options = opts || {};
  const env = options.env || process.env;
  const target = file || path.join(process.cwd(), '.env');
  const result = { load: [], kept: [] };
  if (!fs.existsSync(target)) return result;
  let parsed;
  try {
    parsed = parse(fs.readFileSync(target, 'utf8'), env);
  } catch (e) {
    if (options.log) options.log('[env] 读取 ' + target + ' 失败：' + e.message);
    return result;
  }
  for (const key of Object.keys(parsed)) {
    if (!options.override && env[key] !== undefined && env[key] !== '') { result.kept.push(key); continue; }
    env[key] = parsed[key];
    result.load.push(key);
  }
  if (options.log) {
    options.log('[env] 已加载 ' + target + '：' + (result.load.join(', ') || '无新增')
      + (result.kept.length ? '（保留已有：' + result.kept.join(', ') + '）' : ''));
  }
  return result;
}

module.exports = { loadDotEnv, parse };
