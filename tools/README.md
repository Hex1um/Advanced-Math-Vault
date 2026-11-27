# tools 目录说明

脚本按「什么时候会用到」分层，避免一次性历史脚本和日常运维脚本混在一起。

```
tools/ops/       日常运维：部署、同步、备份、发布静态站
  build-pages.mjs          public/ → docs/（GitHub Pages 产物）
  deploy.mjs               先同步线上用户数据再发布（必须 --publish）
  sync-live.mjs            把线上用户/帖子/反馈/每日记录合并回本地库
  create-admin.mjs         本地建/重置管理员
  backup-db.mjs            手动备份（导入前、迁移前用）
  export-batch.mjs         线上审核通过的题脱敏回流到 data/batch-*.json
  migrate-json-to-sqlite.mjs   db.json → db.sqlite 一次性迁移 + 逐行校验

tools/verify/    只读校验，CI 门禁就跑这些
  smoke.mjs                全链路冒烟（121 项断言，支持 --engine=sqlite）
  robustness-check.mjs     题库体检：重复编号、字段、标签、矩阵、KaTeX、悬空引用
  check-katex.mjs          真 KaTeX 逐片段校验（--max-fail=0 用于 CI）
  store-test.mjs           存储层自测：导入 / 增量落盘 / 重载一致性
  mail-test.mjs            邮件通道自测（本地假 SMTP 服务器）
  audit-all.mjs            一站式体检（历史问题扫描，人工看）
  cdp-eval.mjs             Edge 无头 + CDP 跑页面 JS / 截图
  eval-ocr.mjs             OCR 坏例评测
  verify_integrals.py      sympy 对积分答案求导校验
  verify_limits.py         mpmath 50 位精度验证极限

tools/import/    录题流水线
  import-problems.mjs      批量导入（直接写库或走 HTTP 接口）
  import-contest.mjs       竞赛教程题库导入
  import-hust.mjs          TeX 目录 → 题目 JSON
  import-hust-pdf.mjs      PDF 真题导入
  split-exams.mjs          整卷拆单题
  merge-liugy.mjs          合并外部题源
  migrate-tags.mjs         自由标签 → 主/子标签体系
  normalize-notation.mjs   记号统一（单位矩阵 I、bmatrix 等）
  fix-latex.mjs            LaTeX 批处理修复

tools/archive/   已于 v3.12.0 整体删除（audit-kaoyan / retitle-hust / rescore…）
                 这些是「一次性历史作业」，留着会让人以为是可复用工具。
                 需要时用 `git log -- tools/archive/` 找回，历史即归档。
```

## 加新脚本的规矩

1. **只读校验放 `verify/`**：能被 CI 无副作用地重复跑。
2. **会写库的放 `ops/` 或 `import/`**，并且默认 dry-run，加 `--write` / `--apply` 才落盘。
3. 脚本自己定位仓库根目录：`path.join(__dirname, '..', '..')`，不要依赖调用者的 cwd。
4. 凭据一律读环境变量，缺了就直接退出（退出码 2），不要写默认值。
5. **不要往 `package.json` 加新命令**：在 `tools/cli.mjs` 的子命令表里加一行，
   用 `npm run ops <动词>` / `npm run import <动词>` 调。package.json 只保留三类：
   每天要敲的（`test` / `lint` / `check:all`）、CI 工作流直接调用的 `check:*`（改名需要
   workflow scope，所以就地冻结）、以及 `deploy` / `build:pages` 这类关键路径。
6. 新增的**门禁**脚本要进 `check:gates`（npm run check:all 会跑），并且在没有 `data/db.json`
   的环境里要么自动降级取样、要么明确打一行「跳过」后 exit 0 —— CI 里没有运行时库。
