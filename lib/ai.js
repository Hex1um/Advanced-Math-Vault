'use strict';
/**
 * LLM 通道层：提示词、候选通道、地址白名单、调用与降级、可观测性统计。
 *
 * 从 server.js 抽出来（P2-1 Step 2）的原因：
 *   - 这里是「外部依赖 + 安全边界 + 降级策略」最集中的一段，单独成文件才能被单测和审计盯住；
 *   - 不引入任何依赖，仍然只用 node 内置 fetch。
 *
 * db 用 Proxy 转发到调用方当前的库对象：server.js 在启动时会重新赋值 db
 * （JSON 载入 / SQLite attach 成 Proxy），直接把引用传进来会拿到过期对象。
 */

module.exports = function createAi(deps) {
  const getDb = deps && deps.getDb;
  const tagTax = (deps && deps.tagTax) || require('../tag-taxonomy.js');
  const saveDb = (deps && deps.saveDb) || function () {};
  const normalizeProblem = (deps && deps.normalizeProblem) || function (x) { return x; };
  const onStatsChange = (deps && deps.onStatsChange) || function () {};
  const log = (deps && deps.log) || console.error;
  /* 由 server.js 注入的常量（难度上限、来源标签），避免在两个文件里各写一份 */
  const constants = (deps && deps.constants) || {};
  const DIFF_MAX = Number(constants.DIFF_MAX) || 15;
  const EXAM_TAGS = Array.isArray(constants.EXAM_TAGS) ? constants.EXAM_TAGS : [];

  const db = new Proxy({}, {
    get(_, prop) {
      const d = typeof getDb === 'function' ? getDb() : null;
      return d ? d[prop] : undefined;
    },
    set(_, prop, value) {
      const d = typeof getDb === 'function' ? getDb() : null;
      if (d) d[prop] = value;
      return true;
    }
  });

/* ------------------------------------------------------------- LLM 调用 */

function llmConfigured() {
  return !!(db.settings.llm && db.settings.llm.apiKey);
}

/* 免费公共通道：不需要 Key，站点没配 Key 时自动兜底 */
const FREE_PROVIDERS = process.env.NO_FREE === '1' ? [] : [
  { name: 'Pollinations', baseUrl: 'https://text.pollinations.ai/openai', model: 'openai-fast' },
  { name: 'Pollinations', baseUrl: 'https://text.pollinations.ai/openai', model: 'openai' }
];

/* 免费网关偶尔直接回一段错误文本（HTTP 仍是 200），要识别出来继续往下降级 */
const RESPONSE_GUARD = /^(The API key used|Too Many Requests|Rate limit|Unauthorized|Forbidden|Bad Gateway)/i;

const OCR_PROMPT = [
  '你是数学题目转写工具。请把图片里的题目原样转写成 LaTeX。',
  '',
  '绝对规则：',
  '1. 不要改题目，不要改数字、符号、条件；',
  '2. 即使你认为题目有错（如漏条件、结论可疑），也不要修改，原样转写；',
  '3. 不要自己重新表述、不要补充题目没有的内容；',
  '4. 图片里有解答就一并转写；没有解答就不要编造；',
  '5. 分两遍做：第一遍逐行转写，第二遍专门核对上下标、分式、积分上下限、正负号和括号；',
  '6. 看不清的字符写 $\\square$ 占位，不要根据上下文猜一个看起来合理的数字。',
  '',
  '严格按下面格式输出，不要用 JSON、不要代码块、不要解释：',
  '[TITLE]',
  '不超过 18 字的纯文字标题（不要放公式）',
  '[STATEMENT]',
  '完整题干，公式用 $...$ 或 $$...$$ 包住',
  '[TAGS]',
  '最多 3 个考点，用顿号分隔',
  '[THINKING]',
  '1-10 的整数（只衡量「想到方法」的难度；纯计算题给 2-4）',
  '[DIFFICULTY]',
  '1-15 的整数',
  '[CALC]',
  '1-10 的整数',
  '[HINTS]',
  '1-2 条思路提示（没有就写：无）',
  '[ANSWER]',
  '最终答案（图片里没有就写：未给出）',
  '[SOLUTION]',
  '图片里的解答；没有就写：未给出'
].join('\n');

const EXPERT_SYSTEM = [
  '你是高等数学解题专家，带过考研与竞赛，不是通用聊天助手。',
  '',
  '工作顺序（按问题裁剪，但不跳步）：',
  '1. 审题：把条件、所求、定义域、端点、可导性逐条翻译成数学语言，先判断题目是否完整。',
  '2. 定位考点：给出 1-3 个具体考点，并说明判断依据。',
  '3. 选策略：列出候选方法与取舍理由，只推一条主路径，说明为什么不用另一条。',
  '4. 执行：分步推导，每步写清依据（定理名或公式名），不跳关键步骤。',
  '5. 验算：代回、求导、特殊值、极限情形或量纲，至少做一种；验算失败要回头改。',
  '6. 易错点：给 1-2 个最常见错法，指出错在哪一步。',
  '',
  '硬性要求：',
  '- 先独立推导，再参考题库标准解答；标准解答只用于核对结论，不照抄，也不为了迎合它改掉自己的正确结论；',
  '- 题目条件不足时，先指出缺什么；若按常见假设继续，必须写明「以下按……理解」，不要偷偷补条件；',
  '- 学生只问某一步时，只讲那一步，不剧透完整答案；明确要求完整解答时才给全解；',
  '- 不确定的结论直接说「这里需要额外条件 / 我无法确认」，绝不编造数字、条件或定理；',
  '- 公式一律 LaTeX：行内 $...$，独立 $$...$$；不写「希望对你有所帮助」这类客套话，不说「作为一个 AI」。'
].join('\n');

/* 从题库里捞同考点题目，作为参考资料（只给题干和提示，不给解答，避免照抄） */
function retrieveSimilar(problem, limit) {
  if (!problem) return [];
  const tags = problem.tags || [];
  return db.problems
    .filter((p) => p.status === 'approved' && p.code !== problem.code && (p.mainTag === problem.mainTag || p.tags.some((t) => tags.includes(t))))
    .map((p) => ({ p, score: (p.mainTag === problem.mainTag ? 2 : 0) + p.tags.filter((t) => tags.includes(t)).length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 3)
    .map((x) => x.p);
}

function llmMessages(problem, history, opts) {
  opts = opts || {};
  const sys = [EXPERT_SYSTEM];

  if (problem) {
    sys.push('');
    sys.push('## 当前题目');
    sys.push('编号：' + problem.code + '｜标题：' + problem.title);
    sys.push('考点：' + (problem.mainTag || '综合') + ' / ' + (problem.tags || []).join('、'));
    sys.push('题干：' + problem.statement);
    if (problem.hints && problem.hints.length) sys.push('题库分层提示（可逐层给出，不要一次全说）：' + problem.hints.join(' ｜ '));
    if (problem.solution) sys.push('题库标准解答（仅供你核对结论，讲解时按学生进度给，不要整段照搬）：' + problem.solution);
  }

  if (opts.expert !== false && problem) {
    const sims = retrieveSimilar(problem, 3);
    if (sims.length) {
      sys.push('');
      sys.push('## 题库里同类题（可作为类比素材，不要直接给答案）');
      for (const s of sims) {
        sys.push('- ' + s.code + ' ' + s.title + '：考点 ' + s.tags.join('、') + '；题干 ' + String(s.statement).slice(0, 160).replace(/\n+/g, ' '));
      }
    }
  }

  return [{ role: 'system', content: sys.join('\n') }].concat(
    (history || []).slice(-16).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }))
  );
}

/* ------------------------------------------------------- AI 出题 */

function buildGenerateMessages(spec) {
  const mainTag = spec.mainTag && tagTax.isValidMain(spec.mainTag) ? spec.mainTag : '';
  const subs = mainTag ? tagTax.SUB_TAGS[mainTag] : [];
  const tags = (spec.tags && spec.tags.length) ? spec.tags.join('、') : (subs.length ? subs.slice(0, 6).join('、') : '不定积分、定积分、极限、导数、中值定理等高等数学常见考点');
  const sys = [
    '你是高等数学命题老师，负责给大学生出原创练习题。',
    '',
    '严格按下面的分段格式输出，不要用 JSON、不要用代码块、不要写任何解释：',
    '',
    '[TITLE]',
    '不超过18字的纯文字标题（不要放公式）',
    '[STATEMENT]',
    '完整题干，公式用 $...$ 或 $$...$$ 包住，反斜杠照原样写',
    '[TAGS]',
    '2-3 个考点，用顿号分隔',
    '[THINKING]',
    '1-10 的整数',
    '[DIFFICULTY]',
    '1-10 的整数',
    '[CALC]',
    '1-10 的整数',
    '[HINTS]',
    '提示1',
    '提示2',
    '[ANSWER]',
    '最终答案',
    '[SOLUTION]',
    '分步解析，600-800 字，含最后一行「验算：…」，公式同样用 $ 或 $$ 包住',
    '',
    '结构锁定：主标签、子标签、难度、思维量、计算量都由用户给定，不得擅自改动；你只负责把题出好。',
    '',
    '命题要求：',
    '1. 题目必须自洽：符号先定义，条件充分，答案唯一；确实多解时，题干必须写明「有多解」并给全；',
    '2. 难度来自思维台阶，不靠堆计算量；难度低于 6 的题目不要输出；',
    '3. 不使用超纲工具或数值计算器，答案尽量干净；',
    '4. 需要图形时不要依赖图，用文字把位置、长度、垂直/平行关系写清；',
    '5. 先独立解一遍，确认答案可验证，再写解析；解析每一步写依据，不得引入题干没有的符号或条件；',
    '6. 在 [SOLUTION] 的最后一行写「验算：……」，用代回、求导、特殊值或极限情形至少一种方式验证；验算不通过就重出，不要交未验证的题；',
    '7. [ANSWER] 必须是最终结果，不要写「见解析」；',
    '8. 公式必须有定界符，不要把 LaTeX 命令裸露在文字里；不要照抄教材原题；',
    '9. [TAGS] 只写子标签（如「等价无穷小」「分部积分」），不要写「选择题」「证明」这类题型词；',
    '10. 输出前自查：题干、答案、解析三者一致；做不到就换一道更简单但同标签的题。',
    mainTag ? ('11. 主标签固定为「' + mainTag + '」，子标签优先从这些里选：' + subs.join('、')) : ''
  ].filter(Boolean).join('\n');

  const user = [
    '请出一道高数题。',
    '主标签：' + (mainTag || '由你根据考点判断'),
    '考点范围：' + tags,
    '目标难度：' + spec.difficulty + '/' + DIFF_MAX,
    '目标思维量：' + (spec.thinking || 6) + '/10（需要多少洞察才能想到）',
    '目标计算量：' + spec.calc + '/10',
    spec.style ? ('题型偏好：' + spec.style) : '',
    spec.note ? ('额外要求：' + spec.note) : ''
  ].filter(Boolean).join('\n');

  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

/* 分段格式解析（LaTeX 里有 \frac \theta \right 这类，走 JSON 一定被转义吃掉） */
const SECTION_MAP = {
  TITLE: 'title', STATEMENT: 'statement', TAGS: 'tags',
  THINKING: 'thinking', DIFFICULTY: 'difficulty', CALC: 'calc',
  HINTS: 'hints', ANSWER: 'answer', SOLUTION: 'solution', SOURCE: 'source'
};

/* 视觉模型常把段标记写歪：[TAGS]→(TAGS]、[ANSWER→(ANSWER) ；统一把两侧括号夹正成 [TAG]。
   所有分段解析器共用，避免同一份输出在不同解析器里表现不一致。 */
const SECTION_NAMES = 'TITLE|STATEMENT|TAGS|THINKING|DIFFICULTY|CALC|HINTS|ANSWER|SOLUTION|SOURCE|NOTE';
function normalizeSectionMarks(text) {
  const re = new RegExp('[\\[(（]\\s*(' + SECTION_NAMES + ')\\s*[\\])）]', 'gi');
  return String(text || '').replace(re, '[$1]');
}


/* 模型经常把标记写成一行：[TITLE] 不定积分 [STATEMENT] ... —— 上面的解析器只认独占一行，
   这里补一个「标记出现在任意位置」的宽容版，避免整段塞进题干。 */
function parseTaggedInline(text) {
  const t = normalizeSectionMarks(String(text || '')).replace(/\r/g, '');
  const re = /\[(TITLE|STATEMENT|TAGS|THINKING|DIFFICULTY|CALC|HINTS|ANSWER|SOLUTION|SOURCE)\][ \t:：]*/gi;
  const marks = [];
  let m;
  while ((m = re.exec(t)) !== null) marks.push({ key: SECTION_MAP[m[1].toUpperCase()], start: m.index, bodyStart: re.lastIndex });
  if (marks.length < 2) return null;
  const obj = {};
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1].start : t.length;
    obj[cur.key] = t.slice(cur.bodyStart, end).replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  }
  return obj;
}

function parseGenerated(text) {
  const t = normalizeSectionMarks(String(text || '')).replace(/\r/g, '');
  const re = /^[ \t>*#-]*\[(TITLE|STATEMENT|TAGS|THINKING|DIFFICULTY|CALC|HINTS|ANSWER|SOLUTION|SOURCE)\][ \t:：]*$/gim;
  const marks = [];
  let m;
  while ((m = re.exec(t)) !== null) marks.push({ key: SECTION_MAP[m[1].toUpperCase()], start: m.index, bodyStart: re.lastIndex });
  if (marks.length < 2) return null;

  const obj = {};
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1].start : t.length;
    const body = t.slice(cur.bodyStart, end).replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/,'').trim();
    if (cur.key === 'tags') obj.tags = body.split(/[,，、\n]+/).map((x) => x.trim()).filter(Boolean);
    else if (cur.key === 'hints') obj.hints = body.split('\n').map((x) => x.replace(/^[-*·•]\s*/, '').trim()).filter(Boolean);
    else if (['thinking', 'difficulty', 'calc'].includes(cur.key)) {
      const num = body.match(/\d+/);
      obj[cur.key] = num ? Number(num[0]) : undefined;
    } else obj[cur.key] = body;
  }
  if (!obj.statement || obj.statement.length < 10) return null;
  return obj;
}

function repairJsonText(raw) {
  let out = '';
  let inStr = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      const next = raw[i + 1];
      if (next === '\\' || next === '"' || next === '/') { out += '\\' + next; i += 2; continue; }
      if (next === 'b' || next === 'f' || next === 'n' || next === 'r' || next === 't') { out += '\\' + next; i += 2; continue; }
      if (next === 'u') { out += raw.slice(i, i + 6); i += 6; continue; }
      out += '\\\\';
      i += 1;
      continue;
    }
    if (ch === '"') { inStr = false; out += ch; i += 1; continue; }
    if (ch === '\n') { out += '\\n'; i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\t') { out += '\\t'; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

function extractJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  const raw = t.slice(i, j + 1);

  try { return JSON.parse(raw); } catch (e) {}

  // 模型常把 LaTeX 反斜杠写成单转义（\frac），JSON 会报 Bad escaped character，做一次逐字符修复
  let fixed = repairJsonText(raw);
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(fixed); } catch (e) {}

  try {
    const loose = JSON.parse(fixed, function (k, v) { return v; });
    return loose;
  } catch (e) {}
  return null;
}

function validateGenerated(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const item = normalizeProblem(raw);
  if (!item) return null;

  // 标题要能放进列表：去掉公式与换行，实在不能用在就让用户自己改
  let title = String(item.title || '').replace(/\$\$?/g, '').replace(/\s+/g, ' ').trim();
  if (/\\[a-zA-Z]/.test(title) || title.length < 4) title = '待命名 · ' + (item.tags || []).slice(0, 2).join(' / ');
  item.title = title.slice(0, 40);

  if (item.statement.length < 20 || (item.solution || '').length < 40) return null;
  item.source = String(raw.source || 'AI 出题 · 待人工审核').slice(0, 80);
  return item;
}

/* 识图专用校验：图片里常常只有题目没有解答，不能因为 solution 短就把整段判失败。
   占位词（未给出/无）清空，题号式标题（第(3)题）清掉，留给补全步骤填真正的标题与解析。 */
const OCR_PLACEHOLDER = /^(未给出|未|无|暂无|n\/a|na|-+|\/)$/i;
function validateFromImage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const item = normalizeProblem(raw);
  if (!item || !item.statement || item.statement.length < 8) return null;
  if (OCR_PLACEHOLDER.test(item.answer.trim())) item.answer = '';
  if (OCR_PLACEHOLDER.test(item.solution.trim())) item.solution = '';
  if (item.hints.length === 1 && OCR_PLACEHOLDER.test(item.hints[0])) item.hints = [];
  let title = String(raw.title || '').replace(/\$\$?/g, '').replace(/\s+/g, ' ').trim();
  // 「第(3)题」「第11题」「(11)」「3.」这类题号不是标题，清掉让补全生成
  title = stripTitleNumber(title);
  item.title = title.length >= 2 && !/\\[a-zA-Z]/.test(title) ? title.slice(0, 40) : '';
  item.source = String(raw.source || '').slice(0, 80);
  return item;
}

/* 元信息补全：标题/考点/三维/提示/答案/解析。识图与手动补全共用同一套提示词与解析，
   识图时直接复用「识图成功的那个模型」，因此一张图就能靠同一个 Key 补全全部字段。 */
/* 只去掉真正的题号前缀，不能误伤「三角函数」「二次型」「一阶方程」这类标题 */
function stripTitleNumber(title) {
  return String(title || '')
    .replace(/^第\s*[（(]?\s*[\d一二三四五六七八九十]+\s*[）)]?\s*题\s*[.、:：]?\s*/, '')
    .replace(/^[（(]\s*[\d一二三四五六七八九十]+\s*[）)]\s*/, '')
    .replace(/^\d+\s*[.、)]\s*/, '')
    .replace(/^[一二三四五六七八九十]+\s*[、.]\s*/, '')
    .trim();
}

function metaSystem(full) {
  return {
    role: 'system',
    content: [
      '你是数学题库编辑。你只补元信息，不改题干、不改题目条件，也不替题目补它没给的条件。',
      '',
      '规则：',
      '1. 先判断题干是否完整；有缺失或歧义时不要擅自补全，标题照实概括，并在解析里标注「题干疑似缺少……」。',
      '2. 标题 ≤18 字，说清「考什么方法 / 什么对象」，不带题号，不要「求解」「计算题」这类空话。',
      '3. 考点 1-3 个名词短语，用顿号分隔；只写具体子标签（如「等价无穷小」「分部积分」），不要写「选择题」「证明」这类题型词。',
      '4. 三维评分各 1-10 的整数，要有依据：思维量=想到方法有多难（套公式 3-4，需要构造或多步转化 7-9）；难度=综合难度；计算量=实际运算长度。不要把每道题都打成 5。',
      '5. 分层提示 1-3 条：第一条只给方向，不出现关键公式或答案；后面逐步具体，但不要写出最终答案。',
      full ? '6. 答案必须独立验算后再写（代回、求导、特殊值、极限情形至少一种），精确到 LaTeX；解析与答案一致，不得引入题干没有的符号或条件；解析最后一行写「验算：……」。' : '6. 不要写答案和解析。',
      '7. 认不出来的地方写 $\\square$，不要编造数字；宁可留空，也不要给一个看起来合理的错误答案。',
      '',
      '严格按下面的段输出，不要解释、不要代码块：',
      '[TITLE]', '[TAGS]', '[THINKING]', '[DIFFICULTY]', '[CALC]', '[HINTS]', '[ANSWER]', '[SOLUTION]'
    ].join('\n')
  };
}

function parseMetaText(raw, full) {
  const text = normalizeSectionMarks(raw);
  const sec = (tag) => {
    const re = new RegExp('\\[' + tag + '\\]([\\s\\S]*?)(?=\\[[A-Z]+\\]|$)', 'i');
    const m = re.exec(text);
    return m ? m[1].trim() : '';
  };
  // 模型有时把三维塞进一段「思维量=8, 难度=7, 计算量=8」；按标签各取一个数字
  const labeled = (name) => {
    const m = sec(name).match(new RegExp(name + '\\s*[=:：]?\\s*(\\d+)', 'i'));
    return m ? Number(m[1]) : 0;
  };
  const num = (t, tag) => {
    const lv = labeled(tag);
    if (lv >= 1 && lv <= 15) return lv;
    const v = Number(String(t).replace(/[^0-9]/g, ''));
    return v >= 1 && v <= 15 ? v : 0;
  };
  // 标题只留纯文字：去掉公式、引号、题号，避免把 $\int...$ 截断塞进标题框
  let title = sec('TITLE').replace(/\$[^$]*\$/g, '').replace(/`[^`]*`/g, '')
    .replace(/[「」""'。.]/g, '').replace(/\n.*/s, '').trim();
  title = stripTitleNumber(title);
  if (title.length < 2 || /\\[a-zA-Z]/.test(title)) title = '';
  const parsedTags = sec('TAGS').split(/[、,，;；\n]/).map((x) => x.trim()).filter(Boolean);
  const tagInfo = tagTax.normalize(parsedTags);
  if (!title && tagInfo.tags.length) title = tagInfo.tags.slice(0, 2).join('·');
  return {
    title: title.slice(0, 40),
    mainTag: tagInfo.mainTag,
    tags: tagInfo.tags,
    examTags: Array.isArray(raw.examTags) ? raw.examTags.map(String).filter((t) => EXAM_TAGS.includes(t)) : [],
    thinking: num(sec('THINKING'), '思维量'), difficulty: num(sec('DIFFICULTY'), '难度'), calc: num(sec('CALC'), '计算量'),
    hints: sec('HINTS').split(/\n+/).map((x) => x.replace(/^[-*·\d.、\s]+/, '').trim()).filter(Boolean).slice(0, 5),
    answer: full ? sec('ANSWER').trim() : '',
    solution: full ? sec('SOLUTION').trim() : ''
  };
}

async function completeProblemMeta(statement, cfgs) {
  const sys = metaSystem(true);
  const userMsg = { role: 'user', content: '题干：\n' + String(statement || '').slice(0, 1800) };
  for (const cfg of cfgs) {
    try {
      const raw = String(await callLLM(cfg, [sys, userMsg]) || '');
      const out = parseMetaText(raw, true);
      if (out.title || out.tags.length || out.hints.length) return { out: out, cfg: cfg };
    } catch (e) { /* 换下一个通道 */ }
  }
  return null;
}

/* 模型链：用户自带 Key → 站点 Key → 免费通道 → 本地讲解
   baseUrl 由客户端提供，必须先白名单校验再交给服务端 fetch，否则就是 SSRF。 */
const LLM_HOSTS = new Set([
  'api.deepseek.com', 'api.openai.com', 'open.bigmodel.cn', 'dashscope.aliyuncs.com',
  'generativelanguage.googleapis.com', 'api.anthropic.com', 'api.groq.com', 'openrouter.ai',
  'api.moonshot.cn', 'api.minimax.chat', 'text.pollinations.ai', 'pollinations.ai',
  'api.x.ai', 'api.cohere.com', 'api.together.xyz', 'api.fireworks.ai',
  // 免费视觉通道常被用到的几家
  'api.sensenova.cn', 'api-inference.modelscope.cn', 'api.siliconflow.cn',
  'ark.cn-beijing.volces.com', 'hunyuan.tencentcloudapi.com', 'qianfan.baidubce.com'
]);
for (const h of String(process.env.LLM_ALLOWED_HOSTS || '').split(',')) {
  const v = h.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (v) LLM_HOSTS.add(v);
}

function safeLlmBaseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '443') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  // 裸 IP（IPv4/IPv6）、本机与内网域名一律拒绝；再要求命中域名白名单
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.indexOf(':') >= 0) return null;
  if (host === 'localhost' || /\.localhost$/.test(host) || /\.local$/.test(host) || /\.internal$/.test(host)) return null;
  let allowed = false;
  for (const d of LLM_HOSTS) {
    if (host === d || host.endsWith('.' + d)) { allowed = true; break; }
  }
  if (!allowed) return null;
  // 只保留 path，丢掉 query/hash，避免把密钥拼进 URL 后被日志/代理记录
  const path = u.pathname.replace(/\/+$/, '').slice(0, 120);
  return 'https://' + host + path;
}

function userLlmConfig(body) {
  const l = body && body.llm;
  if (!l || !l.apiKey) return null;
  const baseUrl = safeLlmBaseUrl(l.baseUrl || 'https://api.deepseek.com/v1');
  if (!baseUrl) return null;
  return {
    name: '我的 Key',
    mode: 'user-key',
    baseUrl: baseUrl,
    model: String(l.model || 'deepseek-chat').trim().slice(0, 80),
    apiKey: String(l.apiKey).trim()
  };
}

function llmCandidates(body) {
  const list = [];
  const own = userLlmConfig(body);
  if (own) list.push(own);
  const siteBase = safeLlmBaseUrl(db.settings.llm.baseUrl);
  if (llmConfigured() && siteBase) {
    list.push({
      name: '站点模型', mode: 'site',
      baseUrl: siteBase,
      model: db.settings.llm.model,
      apiKey: db.settings.llm.apiKey
    });
  }
  // 站点识图专用 Key（管理员配置），给全站用户读图用
  const vs = db.settings.llmVision;
  const vBase = vs ? safeLlmBaseUrl(vs.baseUrl) : null;
  if (vs && vs.apiKey && vBase) {
    list.push({
      name: '站点识图模型', mode: 'site',
      baseUrl: vBase, model: vs.model, apiKey: vs.apiKey
    });
  }
  if (!body || !body.skipFree) {
    for (const f of FREE_PROVIDERS) {
      list.push({ name: f.name, mode: 'free', baseUrl: f.baseUrl, model: f.model, apiKey: '', timeout: 22000 });
    }
  }
  return list;
}

/* --------------------------------------------------- AI 通道可观测性
   四级降级链一旦某级挂了（免费公共通道最常见），用户端只会看到「答得慢」，
   运维侧完全没有信号。这里按通道记成功/失败/耗时/降级次数，管理员可查。 */
function aiStats() {
  if (!db.meta.aiStats || typeof db.meta.aiStats !== 'object') {
    db.meta.aiStats = { since: new Date().toISOString(), calls: 0, channels: {} };
  }
  const st = db.meta.aiStats;
  if (!st.channels || typeof st.channels !== 'object') st.channels = {};
  return st;
}

function noteAi(cfg, ok, ms, err) {
  try {
    const st = aiStats();
    const name = String((cfg && cfg.name) || '未命名通道');
    const b = st.channels[name] || { ok: 0, fail: 0, msSum: 0, lastOkAt: '', lastErrorAt: '', lastError: '' };
    if (ok) {
      b.ok = (b.ok || 0) + 1;
      b.msSum = (b.msSum || 0) + ms;
      b.lastOkAt = new Date().toISOString();
    } else {
      b.fail = (b.fail || 0) + 1;   // 每失败一次就意味着往下降了一级
      b.lastErrorAt = new Date().toISOString();
      b.lastError = String(err || '').slice(0, 140);
    }
    st.channels[name] = b;
    st.calls = (st.calls || 0) + 1;
    // 统计也走同一批定时刷盘：一次 AI 调用就 saveDb() 会跟着刷全库
    onStatsChange();
  } catch (e) {
    // 统计不能影响主流程
  }
}

async function openChat(cfg, messages, stream) {
  const base = safeLlmBaseUrl(cfg.baseUrl || '');
  if (!base) {
    noteAi(cfg, false, 0, '接口地址不合法或不在域名白名单内');
    throw new Error(cfg.name + ' 的接口地址不合法或不在域名白名单内');
  }
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeout || 30000);
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0.6, stream: !!stream }),
      signal: controller.signal
    });
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? '超时（' + (cfg.timeout || 30000) + 'ms）' : (e && e.message);
    noteAi(cfg, false, Date.now() - t0, msg);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    noteAi(cfg, false, Date.now() - t0, 'HTTP ' + resp.status);
    throw new Error(cfg.name + ' 返回 ' + resp.status + ' ' + t.slice(0, 120));
  }
  noteAi(cfg, true, Date.now() - t0, '');
  return resp;
}

async function callLLM(cfg, messages) {
  const resp = await openChat(cfg, messages, false);
  const j = await resp.json();
  const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  if (RESPONSE_GUARD.test(text.trim())) throw new Error(cfg.name + ' 返回异常内容: ' + text.slice(0, 60));
  return text;
}

async function streamLLM(cfg, messages, onDelta) {
  const resp = await openChat(cfg, messages, true);
  if (!resp.body) throw new Error(cfg.name + ' 没有返回内容');
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let got = 0;
  let pre = '';
  let flushed = false;

  const push = (c) => {
    if (!c) return;
    if (!flushed) {
      pre += c;
      if (pre.length < 24) return;
      if (RESPONSE_GUARD.test(pre.trim())) throw new Error('返回异常内容: ' + pre.slice(0, 60));
      flushed = true;
      got += pre.length;
      onDelta(pre);
      return;
    }
    got += c.length;
    onDelta(c);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        if (!flushed && pre) {
          if (RESPONSE_GUARD.test(pre.trim())) throw new Error('返回异常内容: ' + pre.slice(0, 60));
          got += pre.length;
          onDelta(pre);
          flushed = true;
        }
        return got;
      }
      try {
        const j = JSON.parse(data);
        const c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        push(c);
      } catch (e) {
        if (String(e.message || '').indexOf('返回异常内容') === 0) throw e;
      }
    }
  }
  if (!flushed && pre && !RESPONSE_GUARD.test(pre.trim())) { got += pre.length; onDelta(pre); }
  return got;
}

/* --------------------------------------------------------- 答疑区 AI 回帖 */

  return {
    FREE_PROVIDERS: FREE_PROVIDERS,
    RESPONSE_GUARD: RESPONSE_GUARD,
    OCR_PROMPT: OCR_PROMPT,
    EXPERT_SYSTEM: EXPERT_SYSTEM,
    llmConfigured: llmConfigured,
    retrieveSimilar: retrieveSimilar,
    llmMessages: llmMessages,
    buildGenerateMessages: buildGenerateMessages,
    normalizeSectionMarks: normalizeSectionMarks,
    parseTaggedInline: parseTaggedInline,
    parseGenerated: parseGenerated,
    repairJsonText: repairJsonText,
    extractJson: extractJson,
    validateGenerated: validateGenerated,
    validateFromImage: validateFromImage,
    stripTitleNumber: stripTitleNumber,
    metaSystem: metaSystem,
    parseMetaText: parseMetaText,
    completeProblemMeta: completeProblemMeta,
    safeLlmBaseUrl: safeLlmBaseUrl,
    userLlmConfig: userLlmConfig,
    llmCandidates: llmCandidates,
    aiStats: aiStats,
    noteAi: noteAi,
    openChat: openChat,
    callLLM: callLLM,
    streamLLM: streamLLM
  };
};
