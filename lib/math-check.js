/**
 * 公式文本体检（服务端与工具共用）
 *
 * 检查四件事：`$$` 成对、去掉 $$ 后 `$` 成对、`\left/\right` 数量一致、
 * `\begin{env}` 与 `\end{env}` 栈平衡。
 *
 * 用途：
 *   - CI 门禁（tools/verify/check-unclosed-delims.mjs）
 *   - 服务端 AI 出题/解析落库前的自动门禁，防止模型吐出渲染崩坏的题干
 */
'use strict';

function scanText(text) {
  if (!text || typeof text !== 'string') return [];
  const issues = [];
  const clean = text.replace(/\\\$/g, '  ');

  const blockCount = (clean.match(/\$\$/g) || []).length;
  if (blockCount % 2 !== 0) issues.push('未闭合的块级公式 $$（共出现 ' + blockCount + ' 次）');

  const noBlock = clean.replace(/\$\$/g, '');
  const inlineCount = (noBlock.match(/\$/g) || []).length;
  if (inlineCount % 2 !== 0) issues.push('未闭合的行内公式 $（共出现 ' + inlineCount + ' 次）');

  const leftCount = (text.match(/\\left(?![A-Za-z])/g) || []).length;
  const rightCount = (text.match(/\\right(?![A-Za-z])/g) || []).length;
  if (leftCount !== rightCount) issues.push('\\left(' + leftCount + ') 与 \\right(' + rightCount + ') 数量不匹配');

  const stack = [];
  const envRe = /\\(begin|end)\{([A-Za-z0-9*]+)\}/g;
  let m;
  while ((m = envRe.exec(text)) !== null) {
    const kind = m[1];
    const env = m[2];
    if (kind === 'begin') stack.push(env);
    else if (stack.length === 0 || stack[stack.length - 1] !== env) {
      issues.push('环境闭合错位：\\end{' + env + '}（栈顶：' + (stack[stack.length - 1] || '空') + '）');
      stack.pop();
    } else {
      stack.pop();
    }
  }
  if (stack.length > 0) issues.push('未闭合的环境：' + stack.map((e) => '\\begin{' + e + '}').join(', '));
  return issues;
}

/** 只在「唯一且明显」的情况下自动补齐行尾的 $$，其余不动 */
function autoFixText(text) {
  if (!text || typeof text !== 'string') return { text: text, changed: false };
  const clean = text.replace(/\\\$/g, '  ');
  const blockCount = (clean.match(/\$\$/g) || []).length;
  if (blockCount % 2 === 1 && text.trimEnd().endsWith('$') && !text.trimEnd().endsWith('$$')) {
    return { text: text.replace(/\$\s*$/, '$$'), changed: true };
  }
  return { text: text, changed: false };
}

module.exports = { scanText, autoFixText };
