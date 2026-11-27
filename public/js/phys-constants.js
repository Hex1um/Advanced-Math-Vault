/* 物理常数速查：SI / CGS 高斯制 / 天文三套口径
 *
 * 为什么需要三套：普物写 g=9.8 m/s²，电动力学习惯高斯制（c、e 用 esu），
 * 天体物理默认太阳量 + pc + Gyr。同一道题里混用两套，答案会差 1~3 个数量级，
 * 而学生最常见的错误恰恰是「常数取错制」而不是「公式错」。
 *
 * 用法：
 *   window.PhysConst.tabs()                 → [{key,name,items:[{sym,val,note}]}]
 *   window.PhysConst.block('CGS')           → 常数表 HTML（含三标签切换）
 *   window.PhysConst.bind(root)             → 给 block 生成的表格绑定切换
 */
(function () {
  'use strict';

  const SETS = [
    {
      key: 'SI',
      name: 'SI 物理常数',
      items: [
        { sym: 'g', val: '9.8\\ \\mathrm{m/s^2}', note: '地面重力加速度' },
        { sym: 'G', val: '6.674\\times10^{-11}\\ \\mathrm{N\\cdot m^2/kg^2}', note: '引力常数' },
        { sym: 'c', val: '2.998\\times10^{8}\\ \\mathrm{m/s}', note: '真空中光速' },
        { sym: 'e', val: '1.602\\times10^{-19}\\ \\mathrm{C}', note: '基本电荷' },
        { sym: 'h', val: '6.626\\times10^{-34}\\ \\mathrm{J\\cdot s}', note: '普朗克常数' },
        { sym: '\\hbar', val: '1.055\\times10^{-34}\\ \\mathrm{J\\cdot s}', note: '约化普朗克常数' },
        { sym: 'k_B', val: '1.381\\times10^{-23}\\ \\mathrm{J/K}', note: '玻尔兹曼常数' },
        { sym: 'N_A', val: '6.022\\times10^{23}\\ \\mathrm{mol^{-1}}', note: '阿伏伽德罗常数' },
        { sym: 'R', val: '8.314\\ \\mathrm{J/(mol\\cdot K)}', note: '摩尔气体常数' },
        { sym: '\\varepsilon_0', val: '8.854\\times10^{-12}\\ \\mathrm{F/m}', note: '真空介电常数' },
        { sym: '\\mu_0', val: '4\\pi\\times10^{-7}\\ \\mathrm{H/m}', note: '真空磁导率' },
        { sym: '\\sigma_{SB}', val: '5.670\\times10^{-8}\\ \\mathrm{W/(m^2\\cdot K^4)}', note: '斯特藩-玻尔兹曼常数' },
        { sym: '\\alpha', val: '7.297\\times10^{-3}\\approx 1/137', note: '精细结构常数' },
        { sym: 'a_0', val: '5.292\\times10^{-11}\\ \\mathrm{m}', note: '玻尔半径' },
        { sym: 'm_e', val: '9.109\\times10^{-31}\\ \\mathrm{kg}', note: '电子质量' },
        { sym: 'm_p', val: '1.673\\times10^{-27}\\ \\mathrm{kg}', note: '质子质量' }
      ]
    },
    {
      key: 'CGS',
      name: 'CGS 高斯制',
      items: [
        { sym: 'c', val: '2.998\\times10^{10}\\ \\mathrm{cm/s}', note: '光速' },
        { sym: 'G', val: '6.674\\times10^{-8}\\ \\mathrm{cm^3/(g\\cdot s^2)}', note: '引力常数' },
        { sym: 'h', val: '6.626\\times10^{-27}\\ \\mathrm{erg\\cdot s}', note: '普朗克常数' },
        { sym: '\\hbar', val: '1.055\\times10^{-27}\\ \\mathrm{erg\\cdot s}', note: '约化普朗克常数' },
        { sym: 'k_B', val: '1.381\\times10^{-16}\\ \\mathrm{erg/K}', note: '玻尔兹曼常数' },
        { sym: 'e', val: '4.803\\times10^{-10}\\ \\mathrm{esu}', note: '基本电荷（高斯制）' },
        { sym: 'm_e', val: '9.109\\times10^{-28}\\ \\mathrm{g}', note: '电子质量' },
        { sym: '\\sigma_{SB}', val: '5.670\\times10^{-5}\\ \\mathrm{erg/(cm^2\\cdot s\\cdot K^4)}', note: '斯特藩-玻尔兹曼常数' },
        { sym: '1\\ \\mathrm{erg}', val: '10^{-7}\\ \\mathrm{J}', note: '能量换算' },
        { sym: '1\\ \\mathrm{dyn}', val: '10^{-5}\\ \\mathrm{N}', note: '力换算' },
        { sym: '1\\ \\mathrm{Gs}', val: '10^{-4}\\ \\mathrm{T}', note: '磁感应强度换算' },
        { sym: '1\\ \\mathrm{esu}', val: '3.336\\times10^{-10}\\ \\mathrm{C}', note: '电荷换算' }
      ]
    },
    {
      key: 'ASTRO',
      name: '天文常数',
      items: [
        { sym: 'M_\\odot', val: '1.989\\times10^{30}\\ \\mathrm{kg}', note: '太阳质量' },
        { sym: 'R_\\odot', val: '6.957\\times10^{8}\\ \\mathrm{m}', note: '太阳半径' },
        { sym: 'L_\\odot', val: '3.828\\times10^{26}\\ \\mathrm{W}', note: '太阳光度' },
        { sym: 'T_{eff,\\odot}', val: '5772\\ \\mathrm{K}', note: '太阳有效温度' },
        { sym: '\\mathrm{AU}', val: '1.496\\times10^{11}\\ \\mathrm{m}', note: '天文单位' },
        { sym: '\\mathrm{pc}', val: '3.086\\times10^{16}\\ \\mathrm{m}', note: '秒差距' },
        { sym: '\\mathrm{ly}', val: '9.461\\times10^{15}\\ \\mathrm{m}', note: '光年' },
        { sym: '\\mathrm{yr}', val: '3.156\\times10^{7}\\ \\mathrm{s}', note: '儒略年' },
        { sym: 'H_0', val: '70\\ \\mathrm{km/(s\\cdot Mpc)}', note: '哈勃常数（约）' },
        { sym: 'T_{CMB}', val: '2.725\\ \\mathrm{K}', note: '宇宙微波背景温度' },
        { sym: 'M_\\oplus', val: '5.972\\times10^{24}\\ \\mathrm{kg}', note: '地球质量' },
        { sym: 'R_\\oplus', val: '6.371\\times10^{6}\\ \\mathrm{m}', note: '地球半径' },
        { sym: '\\mathrm{Jy}', val: '10^{-26}\\ \\mathrm{W/(m^2\\cdot Hz)}', note: '央斯基' },
        { sym: '1\\ \\mathrm{mag}', val: '\\text{通量比 } 10^{-0.4}', note: '星等定义' }
      ]
    }
  ];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function tex(s) {
    if (window.Md && window.Md.inlineTex) {
      try { return window.Md.inlineTex('$' + s + '$'); } catch (e) { return esc(s); }
    }
    return esc(s);
  }

  function rows(items) {
    return items.map(function (it) {
      return '<tr><td class="c-sym">' + tex(it.sym) + '</td><td class="c-val">' + tex(it.val) + '</td>'
        + '<td class="c-note">' + esc(it.note || '') + '</td></tr>';
    }).join('');
  }

  /**
   * 三标签常数表。
   * @param {string} active 'SI' | 'CGS' | 'ASTRO'
   * @param {{title?:string, compact?:boolean}} opts
   */
  function block(active, opts) {
    const o = opts || {};
    const key = SETS.some(function (s) { return s.key === active; }) ? active : 'SI';
    const tabs = SETS.map(function (s) {
      return '<button type="button" class="pc-tab' + (s.key === key ? ' active' : '') + '" data-pc="' + s.key + '">'
        + esc(s.name) + '</button>';
    }).join('');
    const panels = SETS.map(function (s) {
      return '<div class="pc-panel' + (s.key === key ? ' active' : '') + '" data-pc-panel="' + s.key + '">'
        + '<table class="pc-table">' + rows(s.items) + '</table></div>';
    }).join('');
    return '<div class="phys-const-block' + (o.compact ? ' compact' : '') + '">'
      + (o.title ? '<div class="pc-title">' + esc(o.title) + '</div>' : '')
      + '<div class="pc-tabs">' + tabs + '</div>' + panels + '</div>';
  }

  /** 给 block() 生成的表格绑定切换（事件委托，重复调用安全） */
  function bind(root) {
    const el = root || document;
    if (el.__pcBound) return;
    el.__pcBound = true;
    el.addEventListener('click', function (ev) {
      const btn = ev.target.closest && ev.target.closest('[data-pc]');
      if (!btn) return;
      const box = btn.closest('.phys-const-block');
      if (!box) return;
      const key = btn.getAttribute('data-pc');
      box.querySelectorAll('[data-pc]').forEach(function (b) { b.classList.toggle('active', b === btn); });
      box.querySelectorAll('[data-pc-panel]').forEach(function (p) {
        p.classList.toggle('active', p.getAttribute('data-pc-panel') === key);
      });
    });
  }

  /** 按题目元数据猜默认口径：高斯制的题默认看 CGS，天文题默认看 ASTRO */
  function defaultTabOf(metas) {
    const list = (metas || []).filter(Boolean);
    const sys = list.map(function (m) { return String(m.unitSystem || 'SI'); });
    if (sys.filter(function (s) { return s === 'CGS'; }).length > sys.length / 2) return 'CGS';
    const course = list.map(function (m) { return String(m.course || ''); });
    if (course.filter(function (c) { return c === 'astro'; }).length > 0) return 'ASTRO';
    return 'SI';
  }

  window.PhysConst = { sets: SETS, tabs: function () { return SETS; }, block: block, bind: bind, defaultTabOf: defaultTabOf };
})();
