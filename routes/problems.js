'use strict';
/**
 * 题库路由组：列表 / 详情 / 判题 / 看答案 / 提示 / 反馈 / 提交记录 / AI 标记。
 *
 * v2.0.0：对外签名统一为 `(router, ctx)`，内部沿用拆分时的分支实现，
 * 依赖改为从 ctx 上取（ctx.db / ctx.services / ctx.http），不再逐个透传 28 个参数。
 */
const { isMathEquivalent } = require('../lib/math-equiv');
const { intParam } = require('../lib/http');
const tagTax = require('../tag-taxonomy');
const physics = require('../lib/physics-equiv');

/**
 * 数值等价兜底：字符串快路径判不出来时，再用采样判等。
 * 不定积分（答案里带 +C）允许与原函数相差常数。
 */
function mathEquivalentAnswer(userAns, refAns) {
  if (!userAns || !refAns) return false;
  const indefinite = /\+\s*C\b/i.test(refAns) || /^\$?\s*\\?int\b/.test(refAns);
  try {
    return !!isMathEquivalent(userAns, refAns, { allowConstantOffset: indefinite }).ok;
  } catch (e) {
    return false;
  }
}

function createProblemsRoutes(deps) {
  const getDb = deps.getDb;
  const {
    fail, send, readBody, clientIp, store,
    levelOf, levelInfo, visibleProblem, fullProblem, xpForProblem,
    logActivity, saveDb, publicUser, publicFeedback, scheduleFeedbackReview, bumpView,
    allTags, tagTree, methodCounts, courseCounts, examTagCounts, FEEDBACK_TYPES, judgeMessages, parseJudge,
    fsrs, processMatchesAnswer, callLLM, llmCandidates, userLlmConfig,
    LEVELS, TRUST_PROXY, VISION_MODEL
  } = deps;

  const OWNS = /^\/api\/problems(\/|$)/;

  return async function handleProblems(req, res, pathname, query, user) {
    const db = getDb();
    const method = req.method;
    if (!OWNS.test(pathname)) return false;

  if (pathname === '/api/problems' && method === 'GET') {
    const codeList = String(query.c || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
    const q = String(query.q || '').trim().toLowerCase();
    const tags = String(query.tags || '').split(',').filter(Boolean);
    const mainTag = String(query.main || '').trim();
    const examTag = String(query.exam || '').trim();
    const level = String(query.level || '').trim();
    const status = String(query.status || 'all');
    const sort = String(query.sort || 'code');
    const page = intParam(query.page, 1, 1, 100000);
    const size = intParam(query.size, 20, 5, 50);
    /* 学科筛选：不传 → math（与 v2.6.0 行为逐字节一致，旧前端不受影响）；
       subject=all 只在管理/组卷场景用，普通前端不传。 */
    const subjectRaw = String(query.subject || '').toLowerCase();
    const subject = subjectRaw === 'all' ? 'all' : tagTax.subjectOf(subjectRaw);
    const method = String(query.method || '').trim();
    /* 课程组：物理的三级筛选（课程组 → 主标签 → 子标签）第一层 */
    const course = String(query.course || '').trim();

    let list = db.problems.filter((p) => p.status === 'approved'
      && (subject === 'all' || tagTax.subjectOf(p.subject) === subject));
    if (q) {
      /* 关键词过滤：SQLite 引擎先用 problem_search 索引把候选缩到几十条，
         再跑同一套内存谓词做精确判定（索引是超集，谓词保证语义与 JSON 引擎完全一致）。
         索引不可用时（老库尚未回填 / LIKE 出错）自动退回全表过滤。 */
      const matchQ = (p) =>
        p.title.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q) ||
        String(p.mainTag || '').toLowerCase().includes(q) ||
        (p.examTags || []).some((t) => t.toLowerCase().includes(q)) ||
        p.tags.some((t) => t.toLowerCase().includes(q)) ||
        String(p.source || '').toLowerCase().includes(q);
      const candidates = store.engine === 'sqlite' ? store.searchProblemCodes(q) : null;
      list = candidates
        ? list.filter((p) => candidates.has(p.code) && matchQ(p))
        : list.filter(matchQ);
    }
    if (codeList.length) list = list.filter((p) => codeList.includes(p.code));
    if (mainTag) list = list.filter((p) => p.mainTag === mainTag);
    if (examTag) list = list.filter((p) => (p.examTags || []).includes(examTag));
    if (tags.length) list = list.filter((p) => tags.every((t) => p.tags.includes(t) || p.mainTag === t || String(p.mainTag || '').includes(t)));
    if (method) {
      /* 物理思想筛选（守恒律 / 微元法 / 量纲分析…），数学题没有这个维度 */
      list = list.filter((p) => ((p.physicsMeta && p.physicsMeta.methods) || []).includes(method));
    }
    if (course && tagTax.isValidCourse(course)) {
      list = list.filter((p) => {
        const ck = (p.physicsMeta && p.physicsMeta.course) || tagTax.courseOfMain(p.mainTag);
        return ck === course;
      });
    }
    if (level) list = list.filter((p) => levelOf(p.difficulty).name === level);
    if (status === 'solved') list = list.filter((p) => user && user.solved && user.solved[p.code]);
    if (status === 'unsolved') list = list.filter((p) => !(user && user.solved && user.solved[p.code]));

    const sorters = {
      code: (a, b) => a.code.localeCompare(b.code),
      difficulty: (a, b) => b.difficulty - a.difficulty || a.code.localeCompare(b.code),
      thinking: (a, b) => b.thinking - a.thinking,
      calc: (a, b) => b.calc - a.calc,
      newest: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt))
    };
    list.sort(sorters[sort] || sorters.code);

    const total = list.length;
    const items = list.slice((page - 1) * size, page * size).map((p) => {
      const v = visibleProblem(p, user);
      if (codeList.length) {
        v.statement = p.statement;
        const solved = user && user.solved && user.solved[p.code];
        v.answer = (solved && (solved.done || solved.revealed)) ? (p.answer || '') : '';
        v.answerLocked = !v.answer;
      }
      return v;
    });
    return send(res, 200, {
      ok: true, items, total, page, size, subject,
      pages: Math.max(1, Math.ceil(total / size)),
      tags: allTags(subject === 'all' ? 'all' : subject),
      tagTree: tagTree(subject === 'all' ? 'math' : subject),
      methods: subject === 'all' ? [] : methodCounts(subject),
      courses: subject === 'physics' ? courseCounts('physics') : [],
      examTags: examTagCounts(),
      levels: LEVELS.map((l) => l.name)
    });
  }

  const problemMatch = pathname.match(/^\/api\/problems\/([A-Za-z0-9-]+)(\/[a-z]+)?$/);
  if (problemMatch) {
    const code = problemMatch[1].toUpperCase();
    const sub = problemMatch[2];
    const p = db.problems.find((x) => x.code === code);
    if (!p) return fail(res, 404, '题目不存在');
    if (p.status !== 'approved' && !(user && (user.role === 'admin' || user.id === p.authorId))) {
      return fail(res, 404, '题目不存在');
    }

    /* 题目反馈：用户提交 → AI 先审阅 → 再转管理员 */
    if (sub === '/feedback' && method === 'POST') {
      if (!user) return fail(res, 401, '请先登录再提交反馈');
      const body = await readBody(req);
      const content = String(body.content || '').trim();
      const type = FEEDBACK_TYPES[body.type] ? String(body.type) : 'other';
      if (content.length < 6) return fail(res, 400, '反馈内容至少 6 个字，请说清是哪一步有问题');
      const imageDesc = String(body.imageDesc || '').slice(0, 200);
      const fb = {
        id: db.meta.feedbackSeq++,
        code: p.code,
        type,
        content: content.slice(0, 2000),
        imageDesc,
        userId: user.id,
        userName: user.name,
        createdAt: new Date().toISOString(),
        status: 'open',
        ai: null,
        adminNote: '',
        handledAt: null,
        handlerName: ''
      };
      db.feedbacks.push(fb);
      saveDb();
      logActivity(user, '反馈了题目 ' + p.code, p.code);
      scheduleFeedbackReview(fb.id);
      return send(res, 200, { ok: true, id: fb.id, message: '反馈已提交，AI 审阅后会转给管理员' });
    }

    if (sub === '/feedback' && method === 'GET') {
      if (!user) return fail(res, 401, '请先登录');
      const mine = db.feedbacks.filter((f) => f.code === p.code && f.userId === user.id);
      return send(res, 200, { ok: true, items: mine.map((f) => publicFeedback(f, user)) });
    }

    if (!sub && method === 'GET') {
      if (bumpView('problem', p.code, clientIp(req, { trustProxy: TRUST_PROXY }))) p.views = (p.views || 0) + 1;
      return send(res, 200, {
        ok: true,
        problem: fullProblem(p, user),
        xpRules: { base: 10 + p.difficulty * 3 + p.thinking + p.calc, revealedPenalty: 0.4, aiPenalty: 0.2 },
        related: db.problems
          .filter((x) => x.status === 'approved' && x.code !== p.code
            && tagTax.subjectOf(x.subject) === tagTax.subjectOf(p.subject)
            && x.tags.some((t) => p.tags.includes(t)))
          .slice(0, 4)
          .map((x) => ({ code: x.code, title: x.title, difficulty: x.difficulty, levelColor: levelOf(x.difficulty).color }))
      });
    }

    if (sub === '/reveal' && method === 'POST') {
      p.attemptCount = (p.attemptCount || 0) + 1;
      if (user) {
        user.solved = user.solved || {};
        const rec = user.solved[p.code];
        if (!rec) {
          user.solved[p.code] = { at: Date.now(), revealed: true, askedAI: false, done: false };
        } else {
          rec.revealed = true;
        }
      }
      saveDb();
      return send(res, 200, {
        ok: true,
        answer: p.answer || '',
        solution: p.solution || '',
        hints: p.hints || []
      });
    }

    if (sub === '/answer' && method === 'POST') {
      if (!user) return fail(res, 401, '登录后才能提交');      const body = await readBody(req, 8 * 1024 * 1024);
      const process = String(body.process || '').trim().slice(0, 4000);
      const answerOnly = body.mode === 'answer' || (!process && String(body.answer || '').trim());
      const only = process || String(body.answer || '').trim();
      const image = typeof body.image === 'string' && body.image.indexOf('data:image/') === 0 ? body.image : '';
      user.solved = user.solved || {};
      user.best = user.best || {};
      user.wrong = user.wrong || {};
      const rec = user.solved[p.code];
      if (rec && rec.done) {
        return send(res, 200, { ok: true, already: true, verdict: 'correct', score: 100, comment: '这道题已经通过了，不用再交', errors: [] });
      }

      if (!only && !image) return fail(res, 400, '写点东西再交：过程，或者至少给出最终答案');
      if (!answerOnly && only && only.length < 20) return fail(res, 400, '过程太短了：至少写清用了什么方法、关键几步怎么来的');

      p.attemptCount = (p.attemptCount || 0) + 1;
      user.attempts = (user.attempts || 0) + 1;   // 用于排行榜显示「做过多少题」

      // 图片判卷：用户自己的视觉 Key 或站点级识图 Key（管理员后台配的）都算可用；
      // 原逻辑只认用户自己的 Key，导致管理员配了站点识图 Key 后全站用户仍无法用图片判卷。
      const own = userLlmConfig(body);
      const hasVision = (own && VISION_MODEL.test(own.model || '')) ||
        llmCandidates(body).some((c) => VISION_MODEL.test(c.model || ''));
      if (image && !hasVision) {
        saveDb();
        return send(res, 200, {
          ok: true, verdict: 'unclear', needVision: true,
          comment: '当前通道读不了图片：在「设置」里填支持图片的 Key（gpt-4o / qwen-vl / glm-4v / claude / gemini），或让管理员在后台配置站点识图模型，或者把过程打成文字再交',
          errors: []
        });
      }

      const prior = db.submissions
        .filter((x) => x.uid === user.id && x.code === p.code)
        .slice(-3);

      let judged = null;
      let judgedBy = '';
      /* ---- 物理题：先跑确定性预检（单位 / 量纲 / 相对误差） ----
         数值+单位题能机器判定时**不消耗 LLM 额度**；符号题把预检结论注入
         Prompt，让模型围绕「单位对不对、量纲通不通」批改，减少幻觉。 */
      const isPhysics = tagTax.subjectOf(p.subject) === 'physics';
      const unitCheck = isPhysics
        ? physics.checkAnswer(only, p.answer, p.physicsMeta || {})
        : null;
      if (isPhysics && unitCheck && (unitCheck.ok || unitCheck.verdict === 'valueOff' || unitCheck.verdict === 'dimensionMismatch')) {
        if (unitCheck.ok) {
          judged = {
            verdict: 'correct',
            score: answerOnly ? 80 : 100,
            comment: answerOnly
              ? '答案与标准值一致（' + unitCheck.detail + '）；只交答案按 80 分计，通过。'
              : '数值、单位与量纲均通过机器核对（' + unitCheck.detail + '），按规则给满分。',
            errors: (unitCheck.warnings || []).map((w) => '单位｜' + w)
          };
          judgedBy = '量纲核对';
        } else if (unitCheck.verdict === 'dimensionMismatch') {
          judged = {
            verdict: 'wrong',
            score: 30,
            comment: unitCheck.detail,
            errors: ['单位｜' + unitCheck.detail]
          };
          judgedBy = '量纲核对';
        } else if (unitCheck.verdict === 'valueOff' && answerOnly) {
          /* 只交答案时，数值不符就是明确的错，不必再叫模型来猜 */
          judged = {
            verdict: 'wrong',
            score: 30,
            comment: unitCheck.detail,
            errors: ['数值｜' + unitCheck.detail]
          };
          judgedBy = '量纲核对';
        }
      }

      for (const cfg of (judged ? [] : llmCandidates(body))) {
        if (image && !VISION_MODEL.test(cfg.model || '')) continue;
        try {
          let msgs = judgeMessages(p, only, !!image, { history: prior, answerOnly, precheck: unitCheck });
          if (image) {
            msgs = [msgs[0], {
              role: 'user',
              content: [
                { type: 'text', text: msgs[1].content },
                { type: 'image_url', image_url: { url: image } }
              ]
            }];
          }
          const out = await callLLM(cfg, msgs);
          const parsed = parseJudge(out);
          judgedBy = cfg.name;
          if (parsed.verdict && parsed.verdict !== 'unclear') { judged = parsed; break; }
        } catch (e) {
          console.error('[judge] ' + cfg.name + ' 失败:', e.message);
        }
      }

      if (!judged) {
        const confirmed = isPhysics && unitCheck
          ? unitCheck.ok
          : (processMatchesAnswer(only, p.answer) || mathEquivalentAnswer(only, p.answer));
        if (confirmed) {
          judged = {
            verdict: 'correct',
            score: answerOnly ? 80 : 100,
            comment: answerOnly
              ? '暂时连不上阅卷模型，只核对了最终答案（正确），按规则给 80 分。'
              : '暂时连不上阅卷模型；已核对结论行的答案正确，按规则给满分，中间步骤未逐项核对。',
            errors: []
          };
          judgedBy = '规则比对';
        } else if (answerOnly) {
          // 只交答案又对不上：直接判错并重扣，别让用户以为「没判」
          judged = { verdict: 'wrong', score: 30, comment: '最终答案和标准答案不一致。只交答案时只核对这一项，请检查计算过程。', errors: [] };
          judgedBy = '规则比对';
        } else {
          saveDb();
          return send(res, 200, {
            ok: true, verdict: 'unclear', judgedBy: '未判定',
            comment: '暂时连不上阅卷模型（免费通道有频率限制），稍后再交一次；想立刻判分可以在「设置」里填自己的 Key。',
            errors: []
          });
        }
      }

      // 分数线与给分规则（2026-11-25 调整）：
      //   正确答案 + 简要思路/过程 → 100 分，中间跳步不扣分
      //   只交正确答案            → 80 分，通过
      //   最终答案错误            → 大幅扣分，不过线
      // 模型常因「跳步 / 不够严谨」把 verdict 压到 partial，这里按结论行的最终答案兜底纠正，
      // 避免同一份提交「无模型 80 分过、有模型 79 分挂」。
      const answerConfirmed = isPhysics && unitCheck
        ? unitCheck.ok
        : (processMatchesAnswer(only, p.answer) || mathEquivalentAnswer(only, p.answer));
      // 防抄答案刷分：看过标准答案 / 问过 AI 的提交，即使结论命中也不给「通过」，
      // 否则学生点「看答案」后原样抄回就能拿满分、把题记为做出。
      const peeked = !!(rec && (rec.revealed || rec.askedAI));
      if (answerConfirmed && judged.verdict !== 'wrong' && !peeked) {
        judged = Object.assign({}, judged, {
          verdict: 'correct',
          score: answerOnly ? 80 : 100,
          comment: answerOnly
            ? '最终答案正确；只交答案按 80 分计，通过。'
            : '最终答案正确；按现行规则，写了思路或过程即给满分，中间步骤未逐项核对。',
          errors: []
        });
      } else if (answerConfirmed && peeked && judged.verdict === 'partial') {
        judged = Object.assign({}, judged, {
          score: Math.min(judged.score || 59, 59),
          comment: '结论与标准答案一致，但你已查看答案或问过 AI，本次不计通过；请独立重做一遍。'
        });
      }
      /* 物理机器判对 + 已看答案：机器判定绕过了模型的 partial 压制，
         这里单独拦一次，否则「看答案 → 抄数值」能直接拿满分。 */
      if (isPhysics && answerConfirmed && peeked && judged.verdict === 'correct') {
        judged = Object.assign({}, judged, {
          verdict: 'partial',
          score: 59,
          comment: '数值与标准答案一致，但你已查看答案或问过 AI，本次不计通过；请独立重做一遍。'
        });
      }
      let score = Number.isFinite(judged.score) ? Math.round(judged.score) : 0;
      score = Math.max(0, Math.min(100, score));
      let verdict = judged.verdict;
      if (verdict === 'correct' && !answerConfirmed && !peeked && !image) {
        // 防提示注入：学生可在**文字过程**里写「老师说这题正确」让模型吐 correct，
        // 但结论并没有标准答案 → 不能凭模型一句话就给满分通过。
        // 图片提交不适用：答案写在照片上，文字 only 为空，answerConfirmed 必然 false；
        // 此时由视觉模型直接读图判定，不能再降级，否则所有正确的图片判卷都被误判为 79。
        verdict = 'partial';
        score = Math.min(score, 79);
        judged.comment = '模型判为正确，但结论里没有核对到标准答案，暂不计通过；请写出明确的最终答案。';
        judged.errors = (judged.errors || []).slice(0, 1);
      }
      if (verdict === 'correct') {
        const base = answerOnly ? 80 : 100;
        score = Math.max(base, score);
      } else if (verdict === 'wrong') {
        score = Math.min(score || 40, 50);   // 出错重罚
      } else {
        score = Math.min(score, 79);         // 部分对/说不清，不给过
      }
      const PASS = 80;
      const passed = verdict === 'correct' && score >= PASS;

      // 记录这次提交
      const submission = {
        id: 'S' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        code: p.code,
        uid: user.id,
        name: user.name,
        at: new Date().toISOString(),
        mode: answerOnly ? 'answer' : 'process',
        process: only.slice(0, 2000),
        hasImage: !!image,
        score: score,
        verdict: verdict,
        comment: judged.comment || '',
        errors: (judged.errors || []).slice(0, 6),
        judgedBy: judgedBy
      };
      db.submissions.push(submission);
      // 每人每题最多留 10 条，避免库无限膨胀
      const same = db.submissions.filter((x) => x.uid === user.id && x.code === p.code);
      if (same.length > 10) {
        const drop = same.slice(0, same.length - 10).map((x) => x.id);
        db.submissions = db.submissions.filter((x) => drop.indexOf(x.id) < 0);
      }

      // 题目统计
      p.scoreSum = (p.scoreSum || 0) + score;
      p.scoreCount = (p.scoreCount || 0) + 1;

      // 用户最高分
      const best = user.best[p.code];
      const isBest = !best || score > best.score;
      if (isBest) user.best[p.code] = { score: score, at: submission.at };

      const payload = {
        ok: true,
        verdict: verdict,
        score: score,
        passed: passed,
        passLine: PASS,
        comment: judged.comment || '',
        errors: judged.errors || [],
        judgedBy: judgedBy,
        submissionId: submission.id,
        appealable: !passed,
        attempt: prior.length + 1,
        isBest: isBest,
        myBest: user.best[p.code].score,
        avgScore: p.scoreCount ? Math.round((p.scoreSum / p.scoreCount) * 10) / 10 : null,
        scoreCount: p.scoreCount,
        /* 物理题额外回传单位/量纲预检：前端在判卷结果里单独高亮一段，
           学生能立刻看到「是量纲错了」还是「是算错了」。 */
        unitCheck: unitCheck ? {
          ok: !!unitCheck.ok,
          verdict: unitCheck.verdict,
          detail: unitCheck.detail,
          warnings: unitCheck.warnings || [],
          mode: unitCheck.mode || ''
        } : undefined
      };

      if (passed) {
        const gained = xpForProblem(p, rec);
        user.solved[p.code] = {
          at: (rec && rec.at) || Date.now(),
          done: true,
          revealed: !!(rec && rec.revealed),
          askedAI: !!(rec && rec.askedAI),
          judged: judgedBy,
          score: score
        };
        user.exp = (user.exp || 0) + gained;
        p.solvedCount = (p.solvedCount || 0) + 1;
        /* 错题本按 FSRS 调度推进：答对按「良好」记，间隔足够长（>=8 天）就出本 */
        const wRec = user.wrong[p.code];
        if (wRec) {
          const next = Object.assign({}, wRec, fsrs.schedule(wRec, 'good', Date.now()));
          next.lastScore = score;
          if (next.intervalDays >= 8) {
            // 达到出本阈值：保留状态在 user.reviewArchive 里，便于统计掌握情况
            user.reviewArchive = user.reviewArchive || {};
            user.reviewArchive[p.code] = {
              intervalDays: next.intervalDays,
              stability: next.stability,
              graduatedAt: Date.now()
            };
            delete user.wrong[p.code];
          } else {
            user.wrong[p.code] = next;
          }
        }
        logActivity(user, '做出 ' + p.code + '（' + score + ' 分），+' + gained + ' 经验', p.code);
        saveDb();
        return send(res, 200, Object.assign(payload, {
          gained: gained, exp: user.exp, level: levelInfo(user.exp), user: publicUser(user)
        }));
      }

      // 没过线：只记一次尝试。
      /* 错题本改成手动收录（2026-11-27）：判错不再自动入本，
         想收就点题页「加入错题本」（POST /api/wrongbook/:code）。
         已经在册的卡片仍然按 FSRS 推进——反复错会更快回到队列，
         只是手滑一次也不会把之前攒的稳定度清零。 */
      user.solved[p.code] = {
        at: (rec && rec.at) || Date.now(),
        done: false,
        revealed: !!(rec && rec.revealed),
        askedAI: !!(rec && rec.askedAI)
      };
      const prevWrong = user.wrong[p.code];
      if (prevWrong) {
        const again = fsrs.schedule(prevWrong, 'again', Date.now());
        if (!prevWrong.reps) again.nextReviewAt = Date.now();
        user.wrong[p.code] = Object.assign({}, prevWrong, again, {
          at: submission.at,
          score: score,
          tries: (prevWrong.tries ? prevWrong.tries : 0) + 1
        });
      }
      saveDb();
      return send(res, 200, payload);
    }

    if (sub === '/history' && method === 'GET') {
      if (!user) return send(res, 200, { ok: true, items: [] });
      const items = db.submissions
        .filter((x) => x.uid === user.id && x.code === p.code)
        .slice(-10)
        .reverse()
        .map((x) => ({
          id: x.id, at: x.at, mode: x.mode, score: x.score, verdict: x.verdict,
          comment: x.comment, errors: x.errors, process: x.process, hasImage: x.hasImage
        }));
      return send(res, 200, { ok: true, items, best: (user.best[p.code] || {}).score || null });
    }

    if (sub === '/solve' && method === 'POST') {
      if (!user) return fail(res, 401, '登录后才能记录做题进度');
      // 反刷经验：必须通过判卷（本人该题有 ≥80 分的提交）才能记「做出」。
      // 原来这个接口谁都能直接调，一 POST 就 +经验、把题算作做出，公开后会被刷榜。
      const bestScore = (user.best && user.best[p.code] && user.best[p.code].score) || 0;
      const hasPassed = bestScore >= 80 || (db.submissions || []).some(
        (s) => s.uid === user.id && s.code === p.code && (s.score || 0) >= 80
      );
      if (!hasPassed) return fail(res, 403, '先通过这道题的判卷（≥80 分）才能记为做出');
      user.solved = user.solved || {};
      const rec = user.solved[p.code];
      if (rec && rec.done) return send(res, 200, { ok: true, already: true, exp: user.exp, gained: 0, level: levelInfo(user.exp) });
      const gained = xpForProblem(p, rec);
      user.solved[p.code] = {
        at: (rec && rec.at) || Date.now(),
        done: true,
        revealed: !!(rec && rec.revealed),
        askedAI: !!(rec && rec.askedAI)
      };
      user.exp = (user.exp || 0) + gained;
      p.solvedCount = (p.solvedCount || 0) + 1;
      logActivity(user, '做出 ' + p.code + '，+' + gained + ' 经验', p.code);
      saveDb();
      return send(res, 200, { ok: true, gained, exp: user.exp, level: levelInfo(user.exp), user: publicUser(user) });
    }

    if (sub === '/ai-flag' && method === 'POST') {
      if (user) {
        user.solved = user.solved || {};
        const rec = user.solved[p.code];
        if (rec) rec.askedAI = true;
        else user.solved[p.code] = { at: Date.now(), revealed: false, askedAI: true, done: false };
        saveDb();
      }
      return send(res, 200, { ok: true });
    }
  }

    // 前缀归本模块但子路径未命中：给明确的 404，别让请求悬着
    if (!res.headersSent && !res.writableEnded) fail(res, 404, '接口不存在');
    return true;
  };
};

/** v2.0.0 统一入口：把 ctx 摊平成旧实现需要的依赖，再挂到路由表上 */
module.exports = function registerProblemsRoutes(router, ctx) {
  const handle = createProblemsRoutes(Object.assign({}, ctx.services, {
    getDb: () => ctx.db,
    store: ctx.store,
    fail: ctx.http.fail,
    send: ctx.http.send,
    readBody: ctx.http.readBody,
    clientIp: ctx.http.clientIp,
  }));

  const run = (rc) => handle(rc.req, rc.res, rc.pathname, rc.query, rc.user);
  router.all('/api/problems', run);
  router.all('/api/problems/*', run);
  return handle;
};
