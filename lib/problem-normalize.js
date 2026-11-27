/**
 * 题目规范化：公式定界符整理、入库质量门禁、查重、字段白名单、编号分配。
 *
 * 从 lib/core.js 抽出来的原因：这是「录入管道」最容易悄悄改坏题干的一段
 * （mathify 多一条正则就可能把 `\%` 变成注释），单独成文件才能配单测盯住。
 *
 * 三个函数要读题库（查重扫全库、编号查重、质量门禁比对标题），
 * 通过 getDb() 注入而不直接 require 库对象 —— 库会在启动时被整体替换（SQLite attach）。
 */
'use strict';

const tagTax = require('../tag-taxonomy');
const { EXAM_TAGS } = require('./config');
const { clampScore, DIFF_MAX } = require('./gamify');

module.exports = function createProblemTools(deps) {
  const getDb = (deps && deps.getDb) || function () { throw new Error('problem-normalize 需要 getDb'); };

  /* 公式定界符整理：模型经常混用 $$...$$ / \[...\] / \(...\)，还可能干脆不写 */
  function mathify(src) {
    let t = String(src || '');
    if (!t) return t;

    // 1) 先处理已经成对的 $...$ / $$...$$，把里面多套的一层 \[ \] \( \) 剥掉
    t = t.replace(/(\${1,2})([\s\S]*?)\1/g, function (m, mark, body) {
      let b = body.trim();
      b = b.replace(/^\\\[/, '').replace(/\\\]$/, '');
      b = b.replace(/^\\\(/, '').replace(/\\\)$/, '');
      return mark + b.trim() + mark;
    });

    // 2) 剩下裸露的 \[...\] / \(...\) 直接换成长定界符
    t = t.replace(/\\\[([\s\S]*?)\\\]/g, function (m, body) { return '$$' + body.trim() + '$$'; });
    t = t.replace(/\\\(([\s\S]*?)\\\)/g, function (m, body) { return '$' + body.trim() + '$'; });

    // 3) 完全没有 $ 的，把含 LaTeX 命令的 ASCII 片段整体包起来
    if (t.indexOf('$') < 0) {
      t = t.replace(/[\t\x20-\x7E]{3,}/g, function (run) {
        if (!/\\[a-zA-Z]|[\^_]/.test(run)) return run;
        const lead = (run.match(/^\s+/) || [''])[0];
        const trail = (run.match(/\s+$/) || [''])[0];
        const core = run.trim().replace(/\t/g, ' ');
        if (core.length < 3) return run;
        const open = (core.match(/\{/g) || []).length;
        const close = (core.match(/\}/g) || []).length;
        if (open !== close) return run;
        const display = /\\int|\\iint|\\iiint|\\sum|\\prod|\\lim/.test(core);
        const mark = display ? '$$' : '$';
        return lead + mark + core + mark + trail;
      });
    }
    return t;
  }

  /* 入库质量门禁：不拦人，但把可疑点在题目上打标，审核后台显示警示 */
  function qualityGate(item, existing) {
    const warns = [];
    const st = String(item.statement || '');
    if (((st.match(/\$/g) || []).length) % 2) warns.push('定界符不配对（$ 个数为奇数）');
    const bare = st.replace(/\$\$[\s\S]*?\$\$/g, '').replace(/\$[^$]*\$/g, '');
    if (/\\[a-zA-Z]{2,}/.test(bare)) warns.push('正文含未包 $ 的 LaTeX 命令');
    if (/答\s*案\s*[：:]|解\s*[：:]/.test(st)) warns.push('题干疑似含答案/解答');
    if (/\\begin\{tasks\}|\\begin\{tabular\}|<table/i.test(st)) warns.push('残留题目环境或 HTML 表格');
    if (/\$\$\$\$/.test(st)) warns.push('连续四个 $');
    const tl = String(item.title || '');
    if (Array.isArray(existing) && tl && existing.some((x) => x.title === tl && x.code !== item.code)) {
      warns.push('标题与库内已有题目重复');
    }
    return warns;
  }

  /* 投稿查重：先把 LaTeX/空白/标点压成可比较的字符串，再用字符二元组 Jaccard 找高相似题。
     只和 approved / pending 比；rejected 的题不挡新投稿。 */
  function dedupeCanon(raw) {
    return String(raw || '')
      .toLowerCase()
      .replace(/\\(?:mathrm|mathbf|mathit|mathsf|mathtt|text|operatorname|mathbb|mathcal)\s*/g, '')
      .replace(/\\(?:left|right|limits|nolimits|displaystyle|textstyle)\b/g, '')
      .replace(/\\[a-zA-Z]+\*?/g, (m) => m.replace(/^\\/, ''))  // 保留命令名（sin/cos 不能都删成空）
      .replace(/\$/g, '')
      .replace(/[\s\u3000]+/g, '')
      .replace(/[，。；：、,.!?！？；：""''`（）()\[\]{}<>《》·—\-_/\\|]/g, '');
  }

  function bigrams(s) {
    const out = new Map();
    for (let i = 0; i + 1 < s.length; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  }

  function jaccard(a, b) {
    if (!a.size && !b.size) return 1;
    let inter = 0, union = 0;
    for (const [g, n] of a) {
      const m = b.get(g) || 0;
      inter += Math.min(n, m);
      union += Math.max(n, m);
    }
    for (const [g, n] of b) if (!a.has(g)) union += n;
    return union ? inter / union : 0;
  }

  function findDuplicateProblem(item) {
    const title = dedupeCanon(item.title);
    const stmt = dedupeCanon(item.statement);
    if (!stmt) return null;
    const stmtGrams = bigrams(stmt);
    const db = getDb();
    let best = null;
    for (const p of db.problems) {
      if (!p || (p.status !== 'approved' && p.status !== 'pending')) continue;
      const other = dedupeCanon(p.statement);
      if (!other) continue;
      const sim = stmt.length < 12 || other.length < 12
        ? (stmt === other ? 1 : 0)
        : jaccard(stmtGrams, bigrams(other));
      const sameTitle = !!title && title === dedupeCanon(p.title);
      if (sim >= 0.92 || (sameTitle && sim >= 0.72)) {
        if (!best || sim > best.score) {
          best = { code: p.code, title: p.title, status: p.status, score: Math.round(sim * 100) };
        }
      }
    }
    return best;
  }

  function normalizeProblem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = String(raw.title || '').trim();
    const statement = String(raw.statement || raw.body || '').trim();
    if (!title || !statement) return null;
    const subject = tagTax.subjectOf(raw.subject);
    const tagInfo = tagTax.normalize(raw.tags, raw.mainTag, subject);
    let hints = raw.hints;
    if (typeof hints === 'string') hints = [hints];
    hints = Array.isArray(hints) ? hints.map((h) => String(h).trim()).filter(Boolean).slice(0, 5) : [];
    const itemOut = {
      code: '',
      subject: subject,
      title: title.slice(0, 120),
      statement: mathify(statement),
      mainTag: tagInfo.mainTag,
      tags: tagInfo.tags,
      examTags: Array.isArray(raw.examTags) ? raw.examTags.map(String).filter((t) => EXAM_TAGS.includes(t)) : [],
      kind: String(raw.kind || tagInfo.kind || '').slice(0, 12),
      thinking: clampScore(raw.thinking, 6),
      difficulty: clampScore(raw.difficulty, 6, DIFF_MAX),
      calc: clampScore(raw.calc !== undefined ? raw.calc : raw.calculation, 5),
      source: String(raw.source || '').slice(0, 80),
      hints: hints.map(mathify),
      answer: mathify(String(raw.answer || '').trim()),
      solution: mathify(String(raw.solution || '').trim()),
      status: 'pending',
      authorId: null,
      authorName: '',
      rejectReason: '',
      createdAt: new Date().toISOString(),
      reviewedAt: null,
      solvedCount: 0,
      attemptCount: 0,
      scoreSum: 0,
      scoreCount: 0
    };
    /* 物理专属元数据只保留白名单字段：投稿/导入的 JSON 不可信，
       多余字段不进库，避免前端渲染时拿到未定义形状。 */
    if (subject === 'physics') itemOut.physicsMeta = cleanPhysicsMeta(raw.physicsMeta, itemOut);
    // 入库门禁（tools/import/gate.mjs）判不了自动验算的题会带这两个字段进库，
    // 审核后台据此显示「待验算：原因」，提醒审核人重点核对推导
    if (raw.needsReview) {
      itemOut.needsReview = true;
      itemOut.reviewReason = String(raw.reviewReason || '').slice(0, 120);
    }
    const warns = qualityGate(itemOut, getDb().problems);
    if (warns.length) itemOut.qualityWarn = warns;
    return itemOut;
  }

  /* numeric：无量纲数值（π、-0.5、信噪比 100）。
     与 numeric_unit 分开是为了让门禁能区分「忘了写单位」和「本来就没有单位」——
     π 没有单位不是缺陷，漏写 m/s 才是。 */
  const PHYS_ANSWER_TYPES = ['symbolic', 'numeric', 'numeric_unit', 'vector', 'choice', 'proof', 'lab_analysis', 'order_of_magnitude'];
  const PHYS_UNIT_SYSTEMS = ['SI', 'CGS', 'astro', 'natural'];

  /** 物理元数据白名单清洗：字段名、类型、上限一次定死，判题链路只认这套形状 */
  function cleanPhysicsMeta(raw, problem) {
    const m = raw && typeof raw === 'object' ? raw : {};
    const type = String(m.answerType || '');
    const diagrams = Array.isArray(m.diagrams) ? m.diagrams.map((d) => ({
      id: String((d && d.id) || 'fig').slice(0, 24),
      src: String((d && d.src) || '').slice(0, 200),
      alt: String((d && d.alt) || '').slice(0, 200),
      placement: (d && d.placement) === 'solution' ? 'solution' : 'statement'
    })).filter((d) => d.src).slice(0, 6) : [];
    /* v3.1 增量字段：课程归属、单位制、数量级容差、前置题、教材索引。
       全部可选，旧题缺字段时按 SI / 由 mainTag 推导课程，行为不变。 */
    const courseRaw = String(m.course || '');
    const course = tagTax.isValidCourse && tagTax.isValidCourse(courseRaw)
      ? courseRaw
      : (tagTax.courseOfMain ? tagTax.courseOfMain(problem && problem.mainTag) : 'misc');
    const systemRaw = String(m.unitSystem || 'SI');
    const unitSystem = PHYS_UNIT_SYSTEMS.indexOf(systemRaw) >= 0 ? systemRaw : 'SI';
    const tolDex = Number.isFinite(Number(m.tolDex)) ? Math.min(2, Math.max(0, Number(m.tolDex))) : null;
    const prereq = Array.isArray(m.prerequisites)
      ? m.prerequisites.map((x) => String(x).toUpperCase().slice(0, 12))
        .filter((x) => /^(HS|PH|PE)[0-9]{3,6}$/.test(x)).slice(0, 6)
      : [];

  return {
    answerType: PHYS_ANSWER_TYPES.indexOf(type) >= 0 ? type : 'symbolic',
    unit: String(m.unit || '').slice(0, 40),
    dimension: Array.isArray(m.dimension) && m.dimension.length === 7 ? m.dimension.map((x) => Number(x) || 0) : null,
    tolRel: Number.isFinite(Number(m.tolRel)) ? Math.min(0.5, Math.max(0, Number(m.tolRel))) : 0.02,
    sigFigs: Number.isFinite(Number(m.sigFigs)) ? Math.min(6, Math.max(1, Math.round(Number(m.sigFigs)))) : null,
    constants: Array.isArray(m.constants) ? m.constants.map((x) => String(x).slice(0, 60)).slice(0, 8) : [],
    methods: Array.isArray(m.methods) ? m.methods.map((x) => String(x).slice(0, 20)).slice(0, 5) : [],
    diagrams: diagrams,
    course: course,
    unitSystem: unitSystem,
    tolDex: tolDex,
    prerequisites: prereq,
    textbookRef: String(m.textbookRef || '').slice(0, 120),
    /* 记录标准答案原始形态，便于排查「入库时被 mathify 改坏」的问题 */
    refAnswer: String(problem && problem.answer || '').slice(0, 400)
  };
}

function nextProblemCode(subject) {
  const db = getDb();
  const key = tagTax.subjectOf(subject);
  const prefix = (tagTax.SUBJECTS[key] || {}).codePrefix || 'HS';
  let code;
  do { code = prefix + db.meta.seq++; } while (db.problems.some((p) => p.code === code));
  return code;
}

  return {
    mathify: mathify,
    qualityGate: qualityGate,
    dedupeCanon: dedupeCanon,
    bigrams: bigrams,
    jaccard: jaccard,
    findDuplicateProblem: findDuplicateProblem,
    normalizeProblem: normalizeProblem,
    cleanPhysicsMeta: cleanPhysicsMeta,
    nextProblemCode: nextProblemCode
  };
};
