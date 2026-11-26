#!/usr/bin/env node
/**
 * 专业物理/天文示意图生成器（离线，零依赖）。
 *
 *   node tools/diagrams/make-svg.mjs                 # 生成全部模板
 *   node tools/diagrams/make-svg.mjs --list          # 只列出模板
 *   node tools/diagrams/make-svg.mjs effective-potential   # 只生成一个
 *
 * 为什么不用 matplotlib：出题时只需要几张结构化示意图，为了三张图引入
 * Python 绘图栈（并让人以为线上依赖变重）不划算。这里用字符串拼 SVG，
 * 输出控制在 30 KB 内，颜色一律 currentColor，暗色模式自动适配。
 *
 * 产物落在 public/assets/diagrams/physics/，命名 physics-<template>.svg，
 * 可直接写进题目的 physicsMeta.diagrams，并通过 gate.mjs 的 SVG 安全门禁。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'public', 'assets', 'diagrams', 'physics');

const HEAD = (w, h, label) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}">`;
const FONT = 'font-family="Georgia, serif"';

const TEMPLATES = {
  /* 有效势曲线：中心力场 U_eff(r) = L²/(2mr²) − k/r，标出离心势垒与束缚/逃逸分界 */
  'effective-potential': () => {
    const w = 360, h = 240, x0 = 40, y0 = h - 40, x1 = w - 20, y1 = 20;
    const pts = [];
    for (let i = 0; i <= 120; i++) {
      const r = 0.6 + i * 0.06;              // r ∈ [0.6, 7.8]
      const u = 1 / (r * r) - 1 / r;          // 取 L²/2m = 1, k = 1
      const px = x0 + ((r - 0.6) / 7.2) * (x1 - x0);
      const py = y0 - ((u + 0.6) / 1.2) * (y0 - y1);
      pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
    }
    const rMin = 2, uMin = 1 / 4 - 1 / 2;     // 极小值点 r=2, U=-0.25
    const cx = x0 + ((rMin - 0.6) / 7.2) * (x1 - x0);
    const cy = y0 - ((uMin + 0.6) / 1.2) * (y0 - y1);
    return HEAD(w, h, '中心力场有效势曲线')
      + `<g stroke="currentColor" fill="none" stroke-width="1.6">`
      + `<path d="M${x0} ${y1} L${x0} ${y0} L${x1} ${y0}" stroke-width="1.2"/>`
      + `<polyline points="${pts.join(' ')}" stroke-width="2.2"/>`
      + `<line x1="${x0}" y1="${cy.toFixed(1)}" x2="${x1}" y2="${cy.toFixed(1)}" stroke-dasharray="5 4" stroke-width="1.2"/>`
      + `</g>`
      + `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.4" fill="currentColor"/>`
      + `<g ${FONT} font-size="12" fill="currentColor">`
      + `<text x="${x1 - 24}" y="${y0 + 16}" font-style="italic">r</text>`
      + `<text x="${x0 - 30}" y="${y1 + 14}" font-style="italic">U</text>`
      + `<text x="${(cx + 8).toFixed(0)}" y="${(cy - 8).toFixed(0)}">r₀</text>`
      + `<text x="${x0 + 8}" y="${y1 + 18}" font-size="11">离心势垒</text>`
      + `<text x="${x1 - 96}" y="${cy - 8}" font-size="11">E = U_min（圆轨道）</text>`
      + `</g></svg>`;
  },

  /* 天球球面三角形：P 天极、Z 天顶、σ 天体，标出时角 H、赤纬 δ、天顶距 z */
  'celestial-triangle': () => {
    return HEAD(340, 280, '天球球面三角形')
      + `<g stroke="currentColor" fill="none" stroke-width="1.6">`
      + `<circle cx="170" cy="150" r="108"/>`
      + `<ellipse cx="170" cy="150" rx="108" ry="34" stroke-dasharray="5 4" stroke-width="1.2"/>`
      + `<path d="M170 42 L96 208"/>`
      + `<path d="M96 208 L246 196"/>`
      + `<path d="M170 42 L246 196"/>`
      + `<path d="M96 208 L170 150" stroke-dasharray="4 4" stroke-width="1.1"/>`
      + `</g>`
      + `<g fill="currentColor" ${FONT} font-size="13">`
      + `<circle cx="170" cy="42" r="3.2"/><text x="178" y="40">P（天极）</text>`
      + `<circle cx="96" cy="208" r="3.2"/><text x="66" y="226">Z（天顶）</text>`
      + `<circle cx="246" cy="196" r="3.2"/><text x="252" y="200">σ</text>`
      + `<text x="152" y="144" font-size="12">H</text>`
      + `<text x="196" y="130" font-size="12">z</text>`
      + `<text x="126" y="196" font-size="11">δ</text>`
      + `<text x="88" y="240" font-size="11">PZ = 90° − φ</text>`
      + `</g></svg>`;
  },

  /* 能级跃迁图：氢原子 n=1..4，标 Lyman / Balmer / Paschen 系 */
  'energy-levels': () => {
    const levels = [
      { n: 1, y: 220, e: '−13.6 eV' },
      { n: 2, y: 150, e: '−3.40 eV' },
      { n: 3, y: 110, e: '−1.51 eV' },
      { n: 4, y: 84, e: '−0.85 eV' }
    ];
    const x0 = 70, x1 = 300;
    return HEAD(360, 260, '氢原子能级与跃迁')
      + `<g stroke="currentColor" stroke-width="1.8" fill="none">`
      + levels.map((l) => `<line x1="${x0}" y1="${l.y}" x2="${x1}" y2="${l.y}"/>`).join('')
      + `</g>`
      + `<g stroke="currentColor" stroke-width="1.4" fill="none">`
      + `<path d="M120 220 L120 150" marker-end=""/>`
      + `<path d="M190 150 L190 220"/>`
      + `<path d="M230 110 L230 150"/>`
      + `<path d="M265 84 L265 110"/>`
      + `</g>`
      + `<g ${FONT} font-size="12" fill="currentColor">`
      + levels.map((l) => `<text x="${x1 + 8}" y="${l.y + 4}">n=${l.n}</text>`
        + `<text x="18" y="${l.y + 4}" font-size="11">${l.e}</text>`).join('')
      + `<text x="126" y="190" font-size="11">Lyman α</text>`
      + `<text x="196" y="190" font-size="11">Balmer Hα</text>`
      + `<text x="236" y="134" font-size="11">Paschen</text>`
      + `<text x="${x0}" y="246" font-size="11">箭头：向下为发射，向上为吸收</text>`
      + `</g></svg>`;
  },

  /* 视向速度与多普勒位移：谱线整体平移，标 Δλ/λ = v/c */
  'doppler-shift': () => {
    const lines = [96, 132, 168, 204];
    return HEAD(360, 220, '视向速度引起的谱线多普勒位移')
      + `<g stroke="currentColor" fill="none" stroke-width="1.6">`
      + `<line x1="30" y1="180" x2="330" y2="180"/>`
      + `<line x1="30" y1="70" x2="330" y2="70" stroke-dasharray="4 4" stroke-width="1.1"/>`
      + lines.map((x) => `<line x1="${x}" y1="180" x2="${x}" y2="96" stroke-width="1.4"/>`).join('')
      + lines.map((x) => `<line x1="${x + 26}" y1="180" x2="${x + 26}" y2="110" stroke-width="1.2" stroke-dasharray="3 3"/>`).join('')
      + `</g>`
      + `<g ${FONT} font-size="12" fill="currentColor">`
      + `<text x="30" y="62">静止参考谱线（实验室）</text>`
      + `<text x="196" y="196" font-size="11">观测谱线整体红移 → 退行</text>`
      + `<text x="40" y="200" font-size="11">Δλ</text>`
      + `<text x="250" y="52" font-size="11">Δλ/λ = v/c</text>`
      + `</g></svg>`;
  }
};

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const k of Object.keys(TEMPLATES)) console.log(k);
    return;
  }
  const only = args.filter((a) => !a.startsWith('--'));
  const names = only.length ? only : Object.keys(TEMPLATES);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const name of names) {
    const fn = TEMPLATES[name];
    if (!fn) {
      console.error('未知模板：' + name + '（可用：' + Object.keys(TEMPLATES).join(', ') + '）');
      process.exitCode = 1;
      continue;
    }
    const svg = fn();
    const file = path.join(OUT_DIR, 'physics-' + name + '.svg');
    fs.writeFileSync(file, svg, 'utf8');
    const kb = (Buffer.byteLength(svg) / 1024).toFixed(1);
    console.log('wrote ' + path.relative(ROOT, file).replace(/\\/g, '/') + ' (' + kb + ' KB)');
    if (Buffer.byteLength(svg) > 300 * 1024) {
      console.error('！超过 gate 的 300 KB 上限');
      process.exitCode = 1;
    }
    /* 与 gate.mjs 同一套危险标签检查：生成器自己先拦一遍 */
    for (const [re, label] of [[/<script[\s>]/i, '<script>'], [/\son[a-z]+\s*=/i, 'on* 事件'], [/<foreignObject/i, 'foreignObject']]) {
      if (re.test(svg)) {
        console.error('！模板含危险内容（' + label + '）：' + name);
        process.exitCode = 1;
      }
    }
  }
}

main();
