#!/usr/bin/env node
/**
 * 跨实例无损增量合并工具
 *
 * 场景：换宿主、灾备切换、从旧实例（v1.2.1）往新实例搬数据。旧实例上常留着
 * 「只存在于旧库」的做题记录与待审投稿，公开接口取不到，只能靠导出的 db.json。
 *
 * 用法：
 *   node tools/ops/merge-instances.mjs --from old-db.json --to data/db.json            # 预检
 *   node tools/ops/merge-instances.mjs --from old-db.json --to data/db.json --apply    # 执行
 *
 * 去重键（确定性，保证重复执行幂等）：
 *   用户    邮箱（不区分大小写）或用户名
 *   提交    映射后 uid + code + at + 过程/答案哈希
 *   待审题  题干规范化哈希（避免覆盖新库同题）
 *   帖子/反馈  createdAt + 内容哈希
 *
 * 写入前强制备份目标库；写入走「临时文件 + rename」，中途崩溃不会留下半个库。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--from') args.from = argv[++i];
    else if (argv[i] === '--to') args.to = argv[++i];
    else if (argv[i] === '--apply') args.apply = true;
  }
  if (!args.from || !args.to) {
    console.error('用法: node tools/ops/merge-instances.mjs --from <旧库.json> --to <目标库.json> [--apply]');
    process.exit(1);
  }
  return args;
}

const normStr = (s) => String(s || '').trim().toLowerCase();
const hashText = (s) => crypto.createHash('sha1').update(String(s || '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);

function main() {
  const { from, to, apply } = parseArgs(process.argv);
  const src = JSON.parse(fs.readFileSync(from, 'utf8'));
  const dst = JSON.parse(fs.readFileSync(to, 'utf8'));

  const report = {
    usersAdded: 0,
    usersMapped: 0,
    submissionsAdded: 0,
    submissionsSkipped: 0,
    pendingProblemsAdded: 0,
    pendingProblemsSkipped: 0,
    postsAdded: 0,
    postRepliesAdded: 0,
    feedbacksAdded: 0,
  };

  // 1. 用户：按邮箱 / 用户名对齐，建立 oldId → newId 映射
  dst.users = dst.users || [];
  const byEmail = new Map();
  const byName = new Map();
  for (const u of dst.users) {
    if (u.email) byEmail.set(normStr(u.email), u);
    if (u.name) byName.set(normStr(u.name), u);
  }

  const userIdMap = new Map();
  for (const oldU of src.users || []) {
    const matched = (oldU.email && byEmail.get(normStr(oldU.email))) || (oldU.name && byName.get(normStr(oldU.name)));
    if (matched) {
      userIdMap.set(oldU.id, matched.id);
      report.usersMapped++;
      continue;
    }
    const cloned = structuredClone(oldU);
    if (dst.users.some((x) => x.id === cloned.id)) cloned.id = `mig_${cloned.id}_${Date.now().toString(36)}`;
    dst.users.push(cloned);
    userIdMap.set(oldU.id, cloned.id);
    if (cloned.email) byEmail.set(normStr(cloned.email), cloned);
    if (cloned.name) byName.set(normStr(cloned.name), cloned);
    report.usersAdded++;
  }

  // 2. 做题记录：uid + code + at + 内容哈希
  dst.submissions = dst.submissions || [];
  const subKeys = new Set(
    dst.submissions.map((s) => `${s.uid || s.userId}|${s.code}|${s.at || s.createdAt}|${hashText(s.process || s.answer)}`)
  );
  for (const oldS of src.submissions || []) {
    const uid = userIdMap.get(oldS.uid || oldS.userId) || oldS.uid || oldS.userId;
    const key = `${uid}|${oldS.code}|${oldS.at || oldS.createdAt}|${hashText(oldS.process || oldS.answer)}`;
    if (subKeys.has(key)) { report.submissionsSkipped++; continue; }
    const cloned = structuredClone(oldS);
    if (cloned.uid) cloned.uid = uid;
    else cloned.userId = uid;
    if (dst.submissions.some((x) => x.id === cloned.id)) cloned.id = `mig_sub_${hashText(key)}`;
    dst.submissions.push(cloned);
    subKeys.add(key);
    report.submissionsAdded++;
  }

  // 3. 待审投稿：只搬 pending，按题干哈希去重，绝不覆盖已入库题目
  dst.problems = dst.problems || [];
  const stmtHashes = new Set(dst.problems.map((p) => hashText(p.statement)));
  const codes = new Set(dst.problems.map((p) => p.code));
  for (const oldP of (src.problems || []).filter((p) => p.status === 'pending')) {
    const h = hashText(oldP.statement);
    if (stmtHashes.has(h)) { report.pendingProblemsSkipped++; continue; }
    const cloned = structuredClone(oldP);
    if (cloned.authorId && userIdMap.has(cloned.authorId)) cloned.authorId = userIdMap.get(cloned.authorId);
    if (!cloned.code || codes.has(cloned.code)) cloned.code = `P_MIG_${h.slice(0, 6).toUpperCase()}`;
    dst.problems.push(cloned);
    stmtHashes.add(h);
    codes.add(cloned.code);
    report.pendingProblemsAdded++;
  }

  // 4. 帖子（含回复）与反馈：createdAt + 内容哈希幂等
  dst.posts = dst.posts || [];
  const postSigs = new Set(dst.posts.map((p) => `${p.createdAt}|${hashText(p.title + (p.body || ''))}`));
  for (const oldPost of src.posts || []) {
    const sig = `${oldPost.createdAt}|${hashText(oldPost.title + (oldPost.body || ''))}`;
    if (postSigs.has(sig)) continue;
    const cloned = structuredClone(oldPost);
    if (cloned.authorId && userIdMap.has(cloned.authorId)) cloned.authorId = userIdMap.get(cloned.authorId);
    if (dst.posts.some((x) => x.id === cloned.id)) {
      cloned.id = (Math.max(0, ...dst.posts.map((x) => Number(x.id) || 0)) || 0) + 1;
    }
    dst.posts.push(cloned);
    postSigs.add(sig);
    report.postsAdded++;
    report.postRepliesAdded += (cloned.replies || []).length;
  }

  dst.feedbacks = dst.feedbacks || [];
  const fbSigs = new Set(dst.feedbacks.map((f) => `${f.createdAt}|${hashText(f.content || f.message)}`));
  for (const oldF of src.feedbacks || []) {
    const sig = `${oldF.createdAt}|${hashText(oldF.content || oldF.message)}`;
    if (fbSigs.has(sig)) continue;
    const cloned = structuredClone(oldF);
    if (cloned.userId && userIdMap.has(cloned.userId)) cloned.userId = userIdMap.get(cloned.userId);
    if (dst.feedbacks.some((x) => x.id === cloned.id)) {
      cloned.id = (Math.max(0, ...dst.feedbacks.map((x) => Number(x.id) || 0)) || 0) + 1;
    }
    dst.feedbacks.push(cloned);
    fbSigs.add(sig);
    report.feedbacksAdded++;
  }

  // 计数器必须追上合并后的最大值，否则新帖/新反馈会拿到已被占用的 id
  dst.meta = dst.meta || { seq: 1001, postSeq: 1, replySeq: 1, feedbackSeq: 1 };
  const maxPost = dst.posts.reduce((m, p) => Math.max(m, Number(p.id) || 0), 0);
  const maxReply = dst.posts.reduce((m, p) => Math.max(m, ...(p.replies || []).map((r) => Number(r.id) || 0)), 0);
  const maxFb = dst.feedbacks.reduce((m, f) => Math.max(m, Number(f.id) || 0), 0);
  dst.meta.postSeq = Math.max(Number(dst.meta.postSeq) || 1, maxPost + 1);
  dst.meta.replySeq = Math.max(Number(dst.meta.replySeq) || 1, maxReply + 1);
  dst.meta.feedbackSeq = Math.max(Number(dst.meta.feedbackSeq) || 1, maxFb + 1);

  console.log('=== 跨实例合并预检报告 ===');
  console.table(report);

  if (!apply) {
    console.log('\n[DRY-RUN] 未写入任何文件。确认无误后追加 --apply 执行合并。');
    return;
  }

  const backupPath = `${to}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(to, backupPath);
  const tmpPath = `${to}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(dst, null, 2), 'utf8');
  fs.renameSync(tmpPath, to);
  console.log(`\n[APPLIED] 合并完成，原库已备份至: ${path.resolve(backupPath)}`);
}

main();
