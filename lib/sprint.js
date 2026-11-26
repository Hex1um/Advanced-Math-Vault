'use strict';
/**
 * 期末突击：学校-科目科目包（subject pack）数据层。
 *
 * 为什么单独一层而不是复用题库：
 *   数学题库的语义是「一道题 = 考点标签 + 三维评分 + 答案 + 解析」，而期末突击要的是
 *   「教材章节 → 考点 → 该考点在期末卷里怎么考」。政治类科目还有单选/判断/简答/论述/
 *   材料分析五种题型，硬塞进 mainTag/tags 体系会把考点树污染成四不像。
 *
 * 科目包是**只读**的 JSON（data/subjects/*.json），随仓库发布；
 * 用户的答题与提问记录写进 db.sprint[uid][packId]，跟着账号走。
 *
 * 题目两种来源：
 *   · 内联：pack.questions[] 直接写题干、选项、答案、解析（政治类、自编题）
 *   · 引用：{ id, ref: 'HS1234' } 从数学题库按编号取题（微积分 B 的往年真题）
 * 引用型在 load 时解析成统一结构，缺编号就跳过并记日志，不让整包失效。
 */

const fs = require('fs');
const path = require('path');

const SCHEMA = 1;
/* 题型：政治类用前五种，数学类用后三种。判分只对 single/judge 自动，
   其余一律回「得分点/答案自评」——数学解答题本来也不该机器判。 */
const Q_TYPES = ['single', 'judge', 'short', 'essay', 'material', 'fill', 'calc', 'proof', 'code', 'reading', 'cloze'];
const TYPE_NAME = {
  single: '单项选择题',
  judge: '判断题',
  short: '简答题',
  essay: '论述题',
  material: '材料分析题',
  fill: '填空题',
  calc: '计算题',
  proof: '证明题',
  code: '程序题',
  reading: '阅读理解',
  cloze: '选词填空'
};
/* 客观题自动判分，主观题只能给「得分点 + AI 点评」 */
const OBJECTIVE = { single: true, judge: true };

function str(v, max) {
  return String(v === undefined || v === null ? '' : v).trim().slice(0, max || 4000);
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/** 题干归一化，用于「同类题不重复出现」与判重 */
function normText(s) {
  return String(s || '').replace(/\s+/g, '').replace(/[\\$]/g, '').toLowerCase();
}

module.exports = function createSprint(deps) {
  const o = deps || {};
  const dir = o.dir;
  const log = o.log || function () {};
  /* 引用型题目要从题库取题；db 在 server 启动时会被重新赋值，所以每次调用时取 */
  const getDb = o.getDb || function () { return null; };

  /** @type {Map<string, object>} packId → pack（含索引，均已冻结解析结果） */
  const packs = new Map();
  const problemsByCode = new Map();

  function reindexProblems() {
    problemsByCode.clear();
    const db = getDb();
    for (const p of asArray(db && db.problems)) {
      if (p && p.code) problemsByCode.set(String(p.code), p);
    }
  }

  /* ------------------------------------------------------------ 校验 */

  function validate(raw, file) {
    const errors = [];
    if (!raw || typeof raw !== 'object') return ['不是对象'];
    if (!raw.id) errors.push('缺 id');
    if (!raw.school) errors.push('缺 school');
    if (!raw.subject) errors.push('缺 subject');
    if (!raw.year) errors.push('缺 year');
    if (!asArray(raw.chapters).length) errors.push('缺 chapters');
    if (!asArray(raw.points).length) errors.push('缺 points');

    const chapterIds = new Set(asArray(raw.chapters).map((c) => c && c.id).filter(Boolean));
    const pointIds = new Set();
    for (const p of asArray(raw.points)) {
      if (!p || !p.id) { errors.push('知识点缺 id'); continue; }
      if (pointIds.has(p.id)) errors.push('知识点 id 重复: ' + p.id);
      pointIds.add(p.id);
      if (!p.chapter || !chapterIds.has(p.chapter)) errors.push('知识点 ' + p.id + ' 的 chapter 不存在: ' + p.chapter);
      if (!p.title) errors.push('知识点 ' + p.id + ' 缺 title');
      if (!p.core) errors.push('知识点 ' + p.id + ' 缺 core（背诵结论）');
    }

    const qIds = new Set();
    for (const q of asArray(raw.questions)) {
      if (!q || !q.id) { errors.push('题目缺 id'); continue; }
      if (qIds.has(q.id)) errors.push('题目 id 重复: ' + q.id);
      qIds.add(q.id);
      if (Q_TYPES.indexOf(q.type) < 0) errors.push('题目 ' + q.id + ' 的 type 非法: ' + q.type);
      if (!q.stem && !q.ref) errors.push('题目 ' + q.id + ' 缺题干或 ref');
      for (const pid of asArray(q.points)) {
        if (!pointIds.has(pid)) errors.push('题目 ' + q.id + ' 指向不存在的知识点: ' + pid);
      }
      if (q.type === 'single' && !q.ref) {
        if (asArray(q.options).length < 2) errors.push('选择题 ' + q.id + ' 选项不足');
        if (!/^[A-D]$/i.test(String(q.answer || ''))) errors.push('选择题 ' + q.id + ' 答案必须是 A-D');
      }
      if (q.type === 'judge' && !q.ref) {
        if (!/^(对|错|√|×|T|F|true|false|1|0)$/i.test(String(q.answer || ''))) {
          errors.push('判断题 ' + q.id + ' 答案必须是 对/错');
        }
      }
    }
    if (errors.length) errors.unshift('科目包 ' + path.basename(file) + ' 校验失败：');
    return errors;
  }

  /* ------------------------------------------------------------ 加载 */

  function normalizeQuestion(raw, pack) {
    const q = {
      id: str(raw.id, 40),
      type: str(raw.type, 12),
      chapter: str(raw.chapter, 40),
      points: asArray(raw.points).map((x) => str(x, 40)).filter(Boolean),
      stem: str(raw.stem, 4000),
      options: asArray(raw.options).map((x) => str(x, 600)),
      answer: str(raw.answer, 1200),
      explain: str(raw.explain || raw.solution, 8000),
      source: str(raw.source, 120),
      difficulty: Math.max(1, Math.min(5, Number(raw.difficulty) || 3)),
      ref: str(raw.ref, 40)
    };
    if (q.ref) {
      const p = problemsByCode.get(q.ref.toUpperCase());
      if (!p) return null;
      q.stem = q.stem || str(p.statement, 4000);
      q.answer = q.answer || str(p.answer, 1200);
      q.explain = q.explain || str(p.solution, 8000);
      q.options = q.options.length ? q.options : [];
      q.source = q.source || str(p.source, 120) || '题库真题';
      q.chapter = q.chapter || str(p.mainTag, 40);
      q.difficulty = q.difficulty || Math.max(1, Math.min(5, Math.round((Number(p.difficulty) || 6) / 3) || 3));
      q.fromBank = true;
      q.bankCode = p.code;
      q.kind = p.kind || '';
      q.title = p.title || '';
    }
    if (q.type === 'single') {
      q.answer = q.answer.toUpperCase().replace(/[^A-D]/g, '').slice(0, 1);
    }
    if (q.type === 'judge') {
      q.answer = /^(对|√|T|true|1)$/i.test(q.answer) ? '对' : '错';
    }
    q.isPast = /真题|期末|期中|考试|试卷/.test(q.source) && !/自编|模拟/.test(q.source);
    return q;
  }

  /** 词库：四六级包用 vocabFile 指向 data/subjects/vocab/*.json，按词条数组读入 */
  function loadVocab(raw) {
    if (!raw || !raw.vocabFile) return [];
    const vf = path.join(dir, String(raw.vocabFile));
    try {
      const arr = JSON.parse(fs.readFileSync(vf, 'utf8'));
      if (!Array.isArray(arr)) throw new Error('词库顶层必须是数组');
      const out = [];
      const seen = new Set();
      for (const it of arr) {
        if (!it || !it.w || !it.cn) continue;
        const w = String(it.w).trim();
        const k = w.toLowerCase();
        if (!w || seen.has(k)) continue;
        seen.add(k);
        out.push({
          w: w,
          ph: str(it.ph, 60),
          pos: str(it.pos, 40),
          cn: str(it.cn, 200),
          ex: str(it.ex, 300),
          exCn: str(it.exCn, 200),
          syn: asArray(it.syn).map((x) => str(x, 40)).filter(Boolean).slice(0, 3)
        });
      }
      return out;
    } catch (e) {
      log('[sprint] 词库读取失败 ' + raw.vocabFile + '：' + e.message);
      return [];
    }
  }

  function buildPack(raw, file) {
    const pack = {
      schema: SCHEMA,
      id: str(raw.id, 60),
      school: str(raw.school, 60),
      schoolShort: str(raw.schoolShort, 20) || str(raw.school, 20),
      subject: str(raw.subject, 80),
      subjectShort: str(raw.subjectShort, 20) || str(raw.subject, 20),
      year: str(raw.year, 12),
      term: str(raw.term, 20),
      intro: str(raw.intro, 400),
      updatedAt: str(raw.updatedAt, 20),
      exam: {
        durationMin: Number(raw.exam && raw.exam.durationMin) || 120,
        totalPoints: Number(raw.exam && raw.exam.totalPoints) || 100,
        sections: asArray(raw.exam && raw.exam.sections).map((s) => ({
          type: str(s.type, 12),
          name: str(s.name, 20) || TYPE_NAME[s.type] || '',
          count: Number(s.count) || 0,
          per: Number(s.per) || 0,
          points: Number(s.points) || 0,
          note: str(s.note, 120)
        }))
      },
      sources: asArray(raw.sources).map((s) => ({
        kind: str(s.kind, 20),
        title: str(s.title, 160),
        note: str(s.note, 200)
      })),
      chapters: asArray(raw.chapters).map((c) => ({
        id: str(c.id, 40),
        no: str(c.no, 12),
        title: str(c.title, 80),
        weight: Number(c.weight) || 2,
        summary: str(c.summary, 600),
        pointIds: []
      })),
      points: [],
      questions: []
    };

    const chapterById = new Map(pack.chapters.map((c) => [c.id, c]));
    for (const raw_p of asArray(raw.points)) {
      const p = {
        id: str(raw_p.id, 60),
        chapter: str(raw_p.chapter, 40),
        title: str(raw_p.title, 120),
        core: str(raw_p.core, 800),
        detail: str(raw_p.detail, 4000),
        keys: asArray(raw_p.keys).map((k) => str(k, 40)).filter(Boolean).slice(0, 12),
        examTypes: asArray(raw_p.examTypes).map((t) => str(t, 12)).filter((t) => Q_TYPES.indexOf(t) >= 0),
        frequency: Math.max(1, Math.min(5, Number(raw_p.frequency) || 3)),
        traps: asArray(raw_p.traps).map((t) => str(t, 200)).filter(Boolean).slice(0, 8),
        related: asArray(raw_p.related).map((r) => str(r, 60)).filter(Boolean).slice(0, 8),
        questionIds: []
      };
      pack.points.push(p);
      const ch = chapterById.get(p.chapter);
      if (ch) ch.pointIds.push(p.id);
    }

    const pointById = new Map(pack.points.map((p) => [p.id, p]));
    for (const raw_q of asArray(raw.questions)) {
      const q = normalizeQuestion(raw_q, pack);
      if (!q) {
        log('[sprint] ' + pack.id + ' 题目 ' + raw_q.id + ' 引用的题库编号不存在：' + raw_q.ref);
        continue;
      }
      /* 没写 points 的引用题：按章节兜底，保证「找类似题」还能捞到它 */
      if (!q.points.length && q.chapter) {
        const ch = chapterById.get(q.chapter);
        if (ch && ch.pointIds.length) q.points = [ch.pointIds[0]];
      }
      if (!Q_TYPES.includes(q.type)) q.type = 'short';
      pack.questions.push(q);
      for (const pid of q.points) {
        const p = pointById.get(pid);
        if (p) p.questionIds.push(q.id);
      }
    }

    pack.vocab = loadVocab(raw);
    pack.vocabByWord = new Map(pack.vocab.map((v) => [v.w, v]));

    pack.chapters = pack.chapters.filter((c) => c.pointIds.length);
    pack.questionById = new Map(pack.questions.map((q) => [q.id, q]));
    pack.pointById = pointById;
    pack.chapterById = chapterById;
    pack.counts = {
      chapters: pack.chapters.length,
      points: pack.points.length,
      questions: pack.questions.length,
      past: pack.questions.filter((q) => q.isPast).length,
      vocab: pack.vocab.length,
      byType: pack.questions.reduce((acc, q) => { acc[q.type] = (acc[q.type] || 0) + 1; return acc; }, {})
    };
    return pack;
  }

  function load() {
    packs.clear();
    reindexProblems();
    if (!dir || !fs.existsSync(dir)) {
      log('[sprint] 没有科目包目录：' + dir);
      return { loaded: 0, errors: [] };
    }
    const errors = [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
    for (const f of files) {
      const full = path.join(dir, f);
      let raw;
      try { raw = JSON.parse(fs.readFileSync(full, 'utf8')); }
      catch (e) { errors.push(f + ' 不是合法 JSON：' + e.message); continue; }
      if (Array.isArray(raw)) { errors.push(f + ' 顶层必须是对象（单科目包）'); continue; }
      const bad = validate(raw, full);
      if (bad.length) { errors.push(...bad); continue; }
      const pack = buildPack(raw, full);
      if (packs.has(pack.id)) { errors.push(f + ' 科目包 id 与已有包重复：' + pack.id); continue; }
      packs.set(pack.id, pack);
    }
    for (const e of errors) log('[sprint] ' + e);
    log('[sprint] 已加载科目包 ' + packs.size + ' 个，题量 '
      + [...packs.values()].reduce((s, p) => s + p.counts.questions, 0));
    return { loaded: packs.size, errors };
  }

  /* ------------------------------------------------------------ 查询 */

  function list() {
    return [...packs.values()]
      .sort((a, b) => (a.school + a.subject).localeCompare(b.school + b.subject, 'zh'))
      .map((p) => ({
        id: p.id,
        school: p.school,
        schoolShort: p.schoolShort,
        subject: p.subject,
        subjectShort: p.subjectShort,
        year: p.year,
        term: p.term,
        intro: p.intro,
        updatedAt: p.updatedAt,
        exam: p.exam,
        counts: p.counts
      }));
  }

  function get(id) {
    return packs.get(String(id || '')) || null;
  }

  /** 章节 + 知识点骨架（不含长文本，用于工作台首屏） */
  function outline(pack) {
    return pack.chapters.map((c) => ({
      id: c.id,
      no: c.no,
      title: c.title,
      weight: c.weight,
      summary: c.summary,
      points: c.pointIds.map((pid) => {
        const p = pack.pointById.get(pid);
        return {
          id: p.id,
          title: p.title,
          core: p.core,
          frequency: p.frequency,
          examTypes: p.examTypes,
          questions: p.questionIds.length
        };
      })
    }));
  }

  function pointDetail(pack, pid) {
    const p = pack.pointById.get(String(pid || ''));
    if (!p) return null;
    const ch = pack.chapterById.get(p.chapter);
    return {
      id: p.id,
      chapter: p.chapter,
      chapterTitle: ch ? (ch.no ? ch.no + ' ' : '') + ch.title : '',
      title: p.title,
      core: p.core,
      detail: p.detail,
      keys: p.keys,
      examTypes: p.examTypes,
      frequency: p.frequency,
      traps: p.traps,
      related: p.related.map((rid) => {
        const r = pack.pointById.get(rid);
        return r ? { id: r.id, title: r.title } : null;
      }).filter(Boolean),
      questions: p.questionIds.length,
      byType: p.questionIds.reduce((acc, qid) => {
        const q = pack.questionById.get(qid);
        if (q) acc[q.type] = (acc[q.type] || 0) + 1;
        return acc;
      }, {})
    };
  }

  /** 题目的对外形状：答案与解析默认不下发 */
  function publicQuestion(q, opts) {
    const reveal = !!(opts && opts.reveal);
    const out = {
      id: q.id,
      type: q.type,
      typeName: TYPE_NAME[q.type] || q.type,
      chapter: q.chapter,
      points: q.points,
      stem: q.stem,
      options: q.options,
      source: q.source,
      isPast: q.isPast,
      difficulty: q.difficulty
    };
    if (q.fromBank) out.bankCode = q.bankCode;
    if (reveal) {
      out.answer = q.answer;
      out.explain = q.explain;
    }
    return out;
  }

  /**
   * 找类似题：先包内真题，再包内自编/引用题，最后交给 AI 出题。
   * 排序把「真题」顶到前面——用户明确要求「往年试卷里有就优先」。
   */
  function similar(pack, opts) {
    const pid = str(opts && opts.pointId, 60);
    const limit = Math.max(1, Math.min(20, Number(opts && opts.limit) || 5));
    const skip = new Set(asArray(opts && opts.exclude).map(String));
    if (!pack) return { items: [], pool: { past: 0, own: 0 } };
    const p = pack.pointById.get(pid);
    if (!p) return { items: [], pool: { past: 0, own: 0 } };

    const pool = p.questionIds
      .map((id) => pack.questionById.get(id))
      .filter((q) => q && !skip.has(q.id));
    const past = pool.filter((q) => q.isPast).sort(byDifficulty);
    const own = pool.filter((q) => !q.isPast).sort(byDifficulty);
    const items = past.concat(own).slice(0, limit);
    return {
      items,
      pool: { past: past.length, own: own.length },
      /* 包内不够就允许 AI 补题，前端据此显示「AI 再出 3 道」 */
      remaining: Math.max(0, Math.min(limit, 5) - items.length)
    };
  }

  function byDifficulty(a, b) {
    return (a.difficulty || 3) - (b.difficulty || 3) || String(a.id).localeCompare(String(b.id));
  }

  /* ------------------------------------------------------------ 判分 */

  function normJudge(v) {
    const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
    if (/^(对|正确|√|t|true|1|是|y|yes)$/.test(s)) return '对';
    if (/^(错|错误|×|x|f|false|0|否|n|no)$/.test(s)) return '错';
    return '';
  }

  /**
   * 客观题判分；主观题返回 needsHuman，让前端把得分点给用户自评 /
   * 或再走 AI 批改。选择题允许传选项全文或序号。
   */
  function grade(q, raw) {
    if (!q) return { ok: false, correct: false, needsHuman: true };
    if (q.type === 'single') {
      let v = String(raw === undefined || raw === null ? '' : raw).trim();
      if (!/^[A-D]$/i.test(v)) {
        const idx = q.options.findIndex((opt) => normText(opt) === normText(v) || normText(opt).replace(/^[A-D][.、\s]*/, '') === normText(v));
        v = idx >= 0 ? String.fromCharCode(65 + idx) : '';
      }
      const got = v.toUpperCase().slice(0, 1);
      return { ok: true, correct: !!got && got === q.answer, expected: q.answer, got };
    }
    if (q.type === 'judge') {
      const got = normJudge(raw);
      return { ok: true, correct: !!got && got === q.answer, expected: q.answer, got };
    }
    return { ok: false, needsHuman: true, points: q.points, answer: q.answer, explain: q.explain };
  }

  /* ------------------------------------------------------------ 进度与薄弱分析 */

  function blankProgress() {
    return { v: 1, attempts: [], stats: {}, reveals: {}, asks: [], plan: '', planAt: 0, vocab: {}, vocabAt: 0 };
  }

  /** 词卡只保留 FSRS 需要的字段：脏字段不留，库文件不会被无意义的键撑大 */
  function normalizeCards(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const w of Object.keys(raw)) {
      const c = raw[w];
      if (!c || typeof c !== 'object' || !w) continue;
      out[w] = {
        stability: Number(c.stability) || 0,
        difficulty: Number(c.difficulty) || 5,
        reps: Number(c.reps) || 0,
        lapses: Number(c.lapses) || 0,
        state: str(c.state, 16) || 'new',
        intervalDays: Number(c.intervalDays) || 0,
        lastReviewAt: Number(c.lastReviewAt) || 0,
        nextReviewAt: Number(c.nextReviewAt) || 0,
        lastGrade: str(c.lastGrade, 16),
        lastResult: str(c.lastResult, 16)
      };
    }
    return out;
  }

  function normalizeProgress(raw) {
    const p = blankProgress();
    if (!raw || typeof raw !== 'object') return p;
    p.attempts = asArray(raw.attempts).slice(-300);
    p.stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
    p.reveals = raw.reveals && typeof raw.reveals === 'object' ? raw.reveals : {};
    p.asks = asArray(raw.asks).slice(-100);
    p.plan = str(raw.plan, 20000);
    p.planAt = Number(raw.planAt) || 0;
    /* 背单词进度：漏了这一步会把 FSRS 卡在保存/读取之间丢掉，表现为「已学」永远 0 */
    p.vocab = normalizeCards(raw.vocab);
    p.vocabAt = Number(raw.vocabAt) || 0;
    return p;
  }

  function recordAnswer(prog, q, result, at) {
    const t = Number(at) || Date.now();
    prog.attempts.push({ qid: q.id, pid: q.points, ok: !!result.correct, at: t });
    if (prog.attempts.length > 300) prog.attempts = prog.attempts.slice(-300);
    for (const pid of q.points) {
      const s = prog.stats[pid] || (prog.stats[pid] = { n: 0, ok: 0 });
      s.n += 1;
      if (result.correct) s.ok += 1;
      s.lastAt = t;
    }
    return prog;
  }

  function recordAsk(prog, pid, question, at) {
    const t = Number(at) || Date.now();
    prog.asks.push({ pid: pid, q: str(question, 300), at: t });
    if (prog.asks.length > 100) prog.asks = prog.asks.slice(-100);
    const s = prog.stats[pid] || (prog.stats[pid] = { n: 0, ok: 0 });
    s.asks = (s.asks || 0) + 1;
    s.lastAsk = t;
    return prog;
  }

  function recordReveal(prog, q, at) {
    const t = Number(at) || Date.now();
    for (const pid of q.points) {
      prog.reveals[pid + '|' + q.id] = t;
      const s = prog.stats[pid] || (prog.stats[pid] = { n: 0, ok: 0 });
      s.reveals = (s.reveals || 0) + 1;
    }
    return prog;
  }

  /**
   * 薄弱度：答错为主，其次是「反复问 AI」和「直接看答案」。
   * 没做过也没问过的知识点不参与排序（不让 100 多个未学考点淹没有效信号）。
   */
  function weakness(pack, rawProg) {
    const prog = normalizeProgress(rawProg);
    const items = [];
    for (const p of pack.points) {
      const s = prog.stats[p.id] || { n: 0, ok: 0 };
      const n = Number(s.n) || 0;
      const ok = Number(s.ok) || 0;
      const asks = Number(s.asks) || 0;
      const reveals = Number(s.reveals) || 0;
      if (!n && !asks && !reveals) continue;
      const acc = n ? ok / n : 0;
      const wrongShare = n ? 1 - acc : 0.6; /* 只问不练：按中等偏弱处理 */
      let score = wrongShare * 60 + Math.min(asks * 8, 24) + Math.min(reveals * 4, 16);
      /* 练得多且基本都对，压到低分区，避免「做过一次全对」也进薄弱榜 */
      if (n >= 3 && acc >= 0.85) score *= 0.45;
      score = Math.round(Math.max(0, Math.min(100, score)));
      const ch = pack.chapterById.get(p.chapter);
      items.push({
        pointId: p.id,
        title: p.title,
        chapter: p.chapter,
        chapterTitle: ch ? (ch.no ? ch.no + ' ' : '') + ch.title : '',
        score,
        attempts: n,
        correct: ok,
        accuracy: n ? Math.round(acc * 100) : null,
        asks,
        reveals,
        level: score >= 60 ? 'weak' : score >= 30 ? 'shaky' : 'ok',
        lastAt: Number(s.lastAt || s.lastAsk || 0)
      });
    }
    items.sort((a, b) => b.score - a.score || b.attempts - a.attempts);

    /* 章节聚合：给「薄弱板块」用，比逐点列表更像用户能理解的说法 */
    const byChapter = new Map();
    for (const it of items) {
      const g = byChapter.get(it.chapter) || {
        chapter: it.chapter, chapterTitle: it.chapterTitle, points: 0, weak: 0, scoreSum: 0, attempts: 0
      };
      g.points += 1;
      g.scoreSum += it.score;
      g.attempts += it.attempts;
      if (it.level === 'weak') g.weak += 1;
      byChapter.set(it.chapter, g);
    }
    const chapters = [...byChapter.values()]
      .map((g) => ({
        chapter: g.chapter,
        chapterTitle: g.chapterTitle,
        points: g.points,
        weakPoints: g.weak,
        attempts: g.attempts,
        score: Math.round(g.scoreSum / Math.max(1, g.points))
      }))
      .sort((a, b) => b.score - a.score);

    const totalPoints = pack.points.length;
    const touched = items.length;
    return {
      items: items.slice(0, 20),
      chapters,
      summary: {
        totalPoints,
        touched,
        weak: items.filter((i) => i.level === 'weak').length,
        untouched: Math.max(0, totalPoints - touched),
        attempts: prog.attempts.length,
        asks: prog.asks.length
      }
    };
  }

  /* ------------------------------------------------------------ AI 提示词 */

  const POLITICS_RULES = [
    '学科纪律：这是高校思政课（习近平新时代中国特色社会主义思想概论），不是通识聊天。',
    '1. 表述以教材与党的文件原文为准，术语不能替换（如「两个确立」「全过程人民民主」「新质生产力」）。',
    '2. 不确定的会议名称、届次、数字、时间，一律不写具体值，改为「有关文件指出」这类不臆造的表述。',
    '3. 不评价现实政治人物与事件，不输出观点性评论；只做知识点解释与答题训练。',
    '4. 遇到与课程无关的问题，直接说明「这个问题超出本课程范围」，不要硬答。'
  ].join('\n');

  function pointContext(pack, p) {
    const ch = pack.chapterById.get(p.chapter);
    return [
      '科目：' + pack.school + '《' + pack.subject + '》' + pack.year + ' 期末',
      '章节：' + (ch ? (ch.no ? ch.no + ' ' : '') + ch.title : ''),
      '考点：' + p.title,
      '背诵结论：' + p.core,
      p.detail ? '教材展开：' + p.detail : '',
      p.keys.length ? '关键词：' + p.keys.join('、') : '',
      p.traps.length ? '易错点：' + p.traps.join('；') : ''
    ].filter(Boolean).join('\n');
  }

  /** 数学类科目：讲解要写推导，题目类型也不同 */
  function isMath(pack) {
    return /微积分|数学|高等代数|线性代数|概率/.test(pack.subject + ' ' + pack.subjectShort);
  }

  function explainMessages(pack, p, opts) {
    const question = str(opts && opts.question, 600);
    const mode = str(opts && opts.mode, 20) || 'explain';
    const system = [
      '你是这门课的期末辅导老师，擅长把教材语言翻译成学生能背、能写、能得分的说法。',
      '',
      mode === 'answer' ? '任务：按考试要求作答，给出可直接写进卷子的答案。' : '任务：讲清这个考点。',
      '输出结构（用 Markdown，不要寒暄）：',
      '1. **一句话结论**：能直接背的定性表述。',
      '2. **为什么**：3-5 条逻辑链，每条一句话，说明「从什么推出什么」。',
      '3. **怎么考**：这个考点在期末卷里以什么题型出现、常见问法、分值大致多少。',
      '4. **答题模板**：分条给「要点 + 展开句式」，简答/论述/材料分析分别怎么写。',
      '5. **易错提醒**：1-3 条最容易写错或漏掉的点。',
      '',
      isMath(pack) ? '公式用 $...$，推导要写清每一步的依据，最后给出结论与检验。' : POLITICS_RULES
    ].join('\n');
    const user = [pointContext(pack, p), question ? '\n学生追问：' + question : ''].join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }
  function generateMessages(pack, p, opts) {
    const want = Math.max(1, Math.min(5, Number(opts && opts.count) || 3));
    const type = str(opts && opts.type, 12);
    const fallback = isMath(pack) ? ['calc', 'fill', 'proof'] : ['single', 'short'];
    const types = type && Q_TYPES.includes(type) ? [type] : (p.examTypes.length ? p.examTypes : fallback);
    const typeList = types.map((t) => TYPE_NAME[t]).join('、');
    const system = isMath(pack) ? [
      '你是命题老师，按给定考点出期末练习题（高等数学）。',
      '只输出 JSON 数组，不要代码块、不要解释。每项字段：',
      '{"type":"calc|fill|proof","stem":"题干","options":[],"answer":"最终答案","explain":"分步解答，每步写清依据","difficulty":1-5}',
      '规则：',
      '· calc 给完整解题过程，答案写成最简形式；fill 只给最终结果；proof 写清构造与推导；',
      '· 题干只考给定考点；不得出现无法验证的数值；',
      '· LaTeX 用 $...$（行内）与 $$...$$（独立）。'
    ].join('\n') : [
      '你是命题老师，按给定考点出期末练习题。',
      '只输出 JSON 数组，不要代码块、不要解释。每项字段：',
      '{"type":"single|judge|short|essay|material","stem":"题干","options":["A. ...","B. ...","C. ...","D. ..."],"answer":"B","explain":"为什么对、其他项错在哪","difficulty":1-5}',
      '规则：',
      '· single 必须有 4 个选项、answer 是 A-D 之一；judge 的 answer 只写「对」或「错」；',
      '· short/essay/material 的 answer 写「得分点」，每条一行，以「① ② ③」编号；options 留空数组；',
      '· 题干只考给定考点，不引入其他章节的内容；',
      '· 不得编造会议届次、文件编号、统计数字；需要引用时用「有关文件指出」。',
      POLITICS_RULES
    ].join('\n');
    const user = [
      pointContext(pack, p),
      '',
      '出 ' + want + ' 道题，题型在 ' + typeList + ' 中选（可以混合）。'
    ].join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  function gradeSubjectiveMessages(pack, q, answer) {
    const system = [
      '你是这门课的阅卷老师。按期末评分标准批改学生答案。',
      '输出结构（Markdown）：',
      '1. **得分**：x / y（满分 y 取题目分值，没给就按 5 分）',
      '2. **踩到的得分点**：逐条列出学生写到的要点',
      '3. **漏掉的得分点**：逐条列出应写但没写的要点',
      '4. **表述问题**：术语不准、逻辑跳跃、缺材料结合等',
      '5. **修改示范**：给出一段可以直接背的参考答案（不超过 200 字）',
      '评分从严但不苛刻：意思对、术语对就给分；只写空话不给分。',
      POLITICS_RULES
    ].join('\n');
    const user = [
      '考点：' + q.points.map((pid) => (pack.pointById.get(pid) || {}).title).filter(Boolean).join('；'),
      '题目：' + q.stem,
      '参考答案/得分点：' + (q.answer || '（未提供）'),
      '学生答案：' + str(answer, 3000)
    ].join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  /** 解析 AI 出的题：尽量宽容（模型常带代码块或前后废话） */
  function parseGeneratedQuestions(text, pack, p) {
    let s = String(text || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
    let arr;
    try { arr = JSON.parse(s); } catch (e) { return []; }
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const raw of arr.slice(0, 5)) {
      if (!raw || !raw.stem) continue;
      const type = Q_TYPES.includes(raw.type) ? raw.type : 'short';
      const q = {
        id: 'ai-' + Date.now().toString(36) + '-' + out.length,
        type: type,
        chapter: p.chapter,
        points: [p.id],
        stem: str(raw.stem, 2000),
        options: asArray(raw.options).map((x) => str(x, 300)),
        answer: str(raw.answer, 1200),
        explain: str(raw.explain || raw.solution, 3000),
        source: 'AI 出题 · 未审核',
        difficulty: Math.max(1, Math.min(5, Number(raw.difficulty) || 3)),
        isPast: false,
        aiGenerated: true
      };
      if (type === 'single') {
        if (q.options.length < 2 || !/^[A-D]$/i.test(q.answer)) continue;
        q.answer = q.answer.toUpperCase().slice(0, 1);
      }
      if (type === 'judge') q.answer = normJudge(q.answer) || '对';
      out.push(q);
    }
    return out;
  }

  /* ------------------------------------------------------------ 改善方案 */

  /**
   * 规则版方案：不依赖模型也能给出一条可执行的路。
   * 有模型时前端再用 /plan?ai=1 换成更细的版本，规则版是兜底。
   */
  function buildPlan(pack, weak) {
    const items = weak.items || [];
    const top = items.slice(0, 6);
    if (!top.length) {
      return {
        title: '先做一轮摸底',
        lines: [
          '你还没有产生足够的答题/提问记录，薄弱分析暂时没有依据。',
          '建议：从第一章开始，每个考点先看「一句话结论」，再做 2 道题，做完回来看这一页。',
          '累计 20 道题以后，薄弱榜就会开始有区分度。'
        ]
      };
    }
    const days = [];
    const perDay = Math.ceil(top.length / 3);
    for (let d = 0; d < 3; d++) {
      const group = top.slice(d * perDay, d * perDay + perDay);
      if (!group.length) continue;
      days.push({
        day: d + 1,
        theme: group.map((g) => g.title).join(' / '),
        steps: group.flatMap((g) => [
          '看「' + g.title + '」的 AI 讲解，先记一句话结论',
          '做该考点 ' + (g.accuracy === null ? 3 : (g.accuracy < 50 ? 5 : 3)) + ' 道题（真题优先）',
          '把答错的那道用一句话写出「错在哪」'
        ])
      });
    }
    const untouchedHint = weak.summary && weak.summary.untouched > 0
      ? '还有 ' + weak.summary.untouched + ' 个考点没碰过，考前至少过一遍它们的「一句话结论」。'
      : '';
    return {
      title: '按薄弱度排的 3 天突击方案',
      lines: [
        '优先级依据：错题率、提问次数、直接看答案的次数。',
        ...days.map((d) => '第 ' + d.day + ' 天｜' + d.theme + '：' + d.steps.slice(0, 3).join('；')),
        untouchedHint
      ].filter(Boolean),
      days
    };
  }

  function planMessages(pack, weak, opts) {
    const days = Math.max(1, Math.min(14, Number(opts && opts.days) || 5));
    const focus = (weak.items || []).slice(0, 8).map((i) => ({
      title: i.title, chapter: i.chapterTitle, score: i.score,
      attempts: i.attempts, accuracy: i.accuracy, asks: i.asks
    }));
    const system = [
      '你是这门课的助教，负责给一个快要期末考的学生排复习计划。',
      '要求：',
      '1. 只依据给出的薄弱数据，不臆测学生水平；',
      '2. 计划必须可执行：每天写「看什么、做几道、怎么自查」，不要写「认真复习」这种空话；',
      '3. 输出 Markdown：一个总览表（天 / 主题 / 任务 / 验收标准）+ 每天一小节；',
      '4. 最后给一条「考场时间分配」建议（按该科目题型与分值）。',
      POLITICS_RULES
    ].join('\n');
    const user = [
      '科目：' + pack.school + '《' + pack.subject + '》' + pack.year,
      '考试蓝图：' + pack.exam.sections.map((s) => s.name + ' ' + s.count + ' 题 / ' + s.points + ' 分').join('，'),
      '薄弱数据：' + JSON.stringify(focus),
      '未学考点数：' + ((weak.summary && weak.summary.untouched) || 0) + ' / ' + pack.points.length,
      '计划天数：' + days
    ].join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  /* ------------------------------------------------------------ 背单词
     四六级词库：卡片 = 一个单词，排期复用错题本的 FSRS（lib/fsrs.js），
     用户评价分「不认识 / 模糊 / 认识」三档，分别映射 again / hard / good。 */

  const VOCAB_RATINGS = ['again', 'hard', 'good', 'easy'];

  function vocabStats(pack, prog) {
    const cards = (prog && prog.vocab) || {};
    const now = Date.now();
    let due = 0;
    for (const w of Object.keys(cards)) {
      if (Number(cards[w] && cards[w].nextReviewAt) <= now) due += 1;
    }
    const learned = Object.keys(cards).length;
    return {
      total: pack.vocab.length,
      learned: learned,
      due: due,
      fresh: Math.max(0, pack.vocab.length - learned)
    };
  }

  /**
   * 取一组词卡：默认「先复习到期、再补新词」。
   * @param {object} pack
   * @param {object} prog 用户进度（含 vocab 字段）
   * @param {{mode?:string, limit?:number}} opts mode: mix|due|new
   */
  function vocabQueue(pack, prog, opts) {
    const o = opts || {};
    const limit = Math.max(1, Math.min(50, Number(o.limit) || 20));
    const mode = o.mode === 'due' || o.mode === 'new' ? o.mode : 'mix';
    const cards = (prog && prog.vocab) || {};
    const now = Date.now();

    const due = [];
    for (const v of pack.vocab) {
      const c = cards[v.w];
      if (!c) continue;
      const next = Number(c.nextReviewAt) || 0;
      if (next > now) continue;
      due.push({ v: v, c: c, overdueDays: Math.floor((now - next) / 86400000) });
    }
    due.sort((a, b) => b.overdueDays - a.overdueDays || (a.c.stability || 0) - (b.c.stability || 0));

    const fresh = pack.vocab.filter((v) => !cards[v.w]);
    const items = [];
    if (mode !== 'new') {
      for (const d of due.slice(0, limit)) {
        items.push({ w: d.v.w, ph: d.v.ph, pos: d.v.pos, cn: d.v.cn, ex: d.v.ex, exCn: d.v.exCn, syn: d.v.syn, kind: 'due', overdueDays: d.overdueDays, reps: d.c.reps || 0 });
      }
    }
    if (mode !== 'due' && items.length < limit) {
      for (const v of fresh.slice(0, limit - items.length)) {
        items.push({ w: v.w, ph: v.ph, pos: v.pos, cn: v.cn, ex: v.ex, exCn: v.exCn, syn: v.syn, kind: 'new', overdueDays: 0, reps: 0 });
      }
    }
    return { items: items, stats: vocabStats(pack, prog) };
  }

  /** 记一次评价：返回新卡（含下次复习时间） */
  function recordVocab(prog, pack, word, rating, fsrs) {
    const w = String(word || '');
    if (!pack.vocabByWord.has(w)) return null;
    if (VOCAB_RATINGS.indexOf(String(rating)) < 0) rating = 'good';
    prog.vocab = prog.vocab || {};
    const next = fsrs.schedule(prog.vocab[w], rating, Date.now());
    next.word = w;
    prog.vocab[w] = next;
    prog.vocabAt = Date.now();
    return next;
  }

  return {
    load,
    list,
    get,
    outline,
    pointDetail,
    publicQuestion,
    similar,
    grade,
    normalizeProgress,
    blankProgress,
    recordAnswer,
    recordAsk,
    recordReveal,
    weakness,
    buildPlan,
    explainMessages,
    generateMessages,
    gradeSubjectiveMessages,
    planMessages,
    parseGeneratedQuestions,
    vocabQueue,
    vocabStats,
    recordVocab,
    VOCAB_RATINGS,
    TYPE_NAME,
    Q_TYPES
  };
};
