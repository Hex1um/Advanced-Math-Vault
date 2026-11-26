#!/usr/bin/env node
/**
 * 物理内容门禁：把「入库前必须确定成立」的检查一次性跑完。
 *
 *   1. 逐题过 tools/import/gate.mjs 的 physicsGate（标签体系、配图白名单与安全、
 *      单位可解析、容差范围）；
 *   2. 每道 numeric_unit 题用**自己的标准答案**跑一遍判题引擎——
 *      这一步能抓出「声明量纲写错」「答案单位与 meta.unit 不一致」这类
 *      人工很难一眼看出的配置错误（学生答对反而被判错的根源）；
 *   3. 符号题只要求能被引擎识别为 symbolic，不要求机器判对。
 *
 * 用法：node tools/verify/check-physics-gate.mjs [文件...]
 *      默认检查 data/batch-physics*.json 与 data/batch-physics-lab.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { physicsGate } from '../import/gate.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const physics = require(path.join(ROOT, 'lib', 'physics-equiv.js'));
const tagTax = require(path.join(ROOT, 'tag-taxonomy.js'));

const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files = argv.length
  ? argv.map((f) => path.resolve(f))
  : fs.readdirSync(path.join(ROOT, 'data'))
    .filter((f) => /^batch-physics.*\.json$/.test(f))
    .map((f) => path.join(ROOT, 'data', f));

let total = 0;
let errors = 0;
let warnings = 0;

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log('跳过（不存在）：' + file);
    continue;
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(data) ? data : data.problems || [];
  console.log('\n' + path.basename(file) + '：' + list.length + ' 题');
  for (const p of list) {
    total++;
    const label = (p.title || '(无标题)').slice(0, 28);
    if (tagTax.subjectOf(p.subject) !== 'physics') {
      console.log('  ✗ ' + label + '｜未声明 subject=physics');
      errors++;
      continue;
    }
    const errs = physicsGate(p, { root: ROOT });
    if (errs.length) {
      errors++;
      console.log('  ✗ ' + label);
      for (const e of errs) console.log('      - ' + e);
      continue;
    }
    const meta = p.physicsMeta || {};
    if (String(meta.answerType) === 'numeric_unit') {
      const self = physics.checkAnswer(p.answer, p.answer, meta);
      if (!self.ok) {
        errors++;
        console.log('  ✗ ' + label + '｜标准答案自检未通过：' + self.detail);
        continue;
      }
      /* 学生按「数值 + meta.unit」作答也必须判对：这是最常见的作答形态。
         不能对答案串做正则取首个数——"9.97\\times10^{4}" 会被截成 9.97，
         必须用引擎自己的 parseQuantity 取到完整数值。 */
      const q = physics.parseQuantity(p.answer);
      if (q.numeric) {
        const plainText = q.value + ' ' + meta.unit;
        const plain = physics.checkAnswer(plainText, p.answer, meta);
        if (!plain.ok) {
          errors++;
          console.log('  ✗ ' + label + '｜按「' + plainText + '」作答被判错：' + plain.detail);
          continue;
        }
      }
    } else if (String(meta.answerType) === 'symbolic') {
      const self = physics.checkAnswer(p.answer, p.answer, meta);
      if (!(self.ok || self.deferred)) {
        errors++;
        console.log('  ✗ ' + label + '｜符号答案自检异常：' + JSON.stringify(self).slice(0, 120));
        continue;
      }
    } else {
      warnings++;
      console.log('  · ' + label + '｜' + (meta.answerType || '未标注') + '：只能人工/AI 评判');
    }

  }
}

console.log('\n合计 ' + total + ' 题：错误 ' + errors + '，人工复核提示 ' + warnings);
if (errors) {
  console.log('物理门禁未通过');
  process.exit(1);
}
console.log('物理门禁通过');
