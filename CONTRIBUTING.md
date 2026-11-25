# 参与贡献

这个仓库是「数海晴岸」（Advanced-Math-Vault）的源码：一个面向高等数学的好题收藏站，前端零构建（原生 HTML/CSS/JS），后端零外部依赖（Node 单进程 + 单文件数据库）。

贡献分两类，要求不一样：**改代码**要过 CI 门禁，**录题**只要符合下面的 Schema 与记号规范。

---

## 本地跑起来

```bash
git clone https://github.com/Hex1um/Advanced-Math-Vault.git
cd Advanced-Math-Vault
node server.js            # http://localhost:8787，自动建空库
```

想要有题可看，用示例题库或 batch 题库：

```bash
SEED_FILE=data/problems.seed.sample.json node server.js   # 10 道经典题
```

想看完整题库（约 2470 道，来自 `data/batch-*.json`）：

```bash
node tools/import/import-problems.mjs data/batch-01.json   # 服务需先停止；逐批导入
```

> 运行时库 `data/db.json` 是 gitignore 的，任何情况下都不要提交它（里面是线上用户数据）。

第一个注册的账号会自动成为管理员（仅 `NODE_ENV=development`）。已有管理员账号时用：

```bash
node tools/ops/create-admin.mjs <用户名> <密码>   # 需先停服务
```

---

## 改代码：提交前必须过这几道

```bash
npm test              # 121 项全链路断言（JSON 引擎）
npm run test:sqlite   # 同一套断言，跑在 SQLite 引擎上（改存储层必跑）
npm run check:store   # 存储层增量落盘 / 重载一致性
npm run check:mail    # 邮件通道（本地假 SMTP，不需要真实凭据）
npm run check:robust  # 题库体检：重复编号、字段、标签、矩阵环境、悬空引用
npm run check:katex   # 公式渲染，必须 0 失败
```

CI（`.github/workflows/smoke.yml`）在 push / PR 到 `main` 时自动跑上面这一串，另外有一个 sympy job 跑 `verify_integrals.py` / `verify_limits.py`。本地过了不代表 CI 会过，反过来亦然——两边都看。

### 硬性约定

- **零依赖**：新增 npm 依赖会被拒。需要的能力用 Node 内置模块（`node:sqlite`、`node:tls`、`fetch`）自己实现，或者做成可选路径。
- **凭据不进仓库**：一律读环境变量，缺失就退出（退出码 2）。历史上曾把管理员密码写进 `sync-live.mjs`，清理过一次，不要再犯。
- **前端零构建**：`public/` 就是站点，改完要 `npm run build:pages` 同步到 `docs/`（Pages 用的产物），并同步升 `index.html` 里的 `?v=` 缓存串。
- **脚本分层**：见 `tools/README.md`。只读校验放 `tools/verify/`，会写库的默认 dry-run。
- **提交信息**：`vX.Y.Z: 一句话结论`，正文写清「改前症状 → 根因 → 改后行为」，数值改动给出前后值。

---

## 录题：JSON Schema

```json
{
  "title": "标题（≤120 字，纯文字或单个行内公式）",
  "statement": "题干。行内公式 $...$，独立公式 $$...$$",
  "mainTag": "积分",
  "tags": ["定积分", "换元与分部"],
  "kind": "解答题",
  "thinking": 6,
  "difficulty": 6,
  "calc": 5,
  "source": "1987 年全国硕士研究生招生考试 数学（一）",
  "hints": ["第一层提示（不给答案）", "第二层提示"],
  "answer": "$\\frac{1}{2}$",
  "solution": "分步解析，Markdown + LaTeX"
}
```

字段约束：

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | ✔ | 2-120 字；同一批里不要重复 |
| `statement` | ✔ | ≥8 字；`$` 必须成对 |
| `mainTag` | ✔ | 九大主标签之一（见下），决定考点雷达归档 |
| `tags` | ✔ | 1-3 个子标签，来自该主标签的子标签表 |
| `kind` | 建议 | 选择题 / 填空题 / 证明题 / 应用题 / 概念题 |
| `thinking` / `difficulty` / `calc` | ✔ | 1-10 整数（难度上限 10） |
| `hints` | 建议 | 最多 5 条，从「往哪想」到「怎么算」，不要直接给答案 |
| `answer` | 建议 | 最终答案，能自动判卷就写标准形式 |
| `solution` | ✔ | 分步解析，每步写清依据 |

九大主标签：`极限与连续`、`导数与微分`、`积分`、`级数`、`微分方程`、`线性代数`、`概率统计`、`空间解析几何`、`综合`。子标签表在 `tag-taxonomy.js`，服务端启动时会把自由标签归并过去。

### 记号规范（评审会按这个逐条看）

- 矩阵用 `bmatrix`：`$\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}$`，不要用 `\left[\begin{array}...`。
- 单位矩阵写 `$I$`，不要写 `$E$` 或 `$\mathbf{1}$`。
- 行列式的竖线用 `\begin{vmatrix}`，并且 `\left|` 与 `\right|` 不要和它混用。
- 大定界符直接跟符号：`\Bigg|`、`\Bigg/`，不要写成 `\Bigg{|}`、`\Bigg{/}`（KaTeX 会报 `Invalid delimiter type`）。
- `&` 只能出现在矩阵 / `cases` / `array` 环境里，普通括号内写 `(1,1,1)`。
- 不要写 `\textbf` / `\emph` / `\noindent` / `\footnote`（KaTeX 不认），用 Markdown 的 `**加粗**`。
- 图片引用用 `![说明](/uploads/xxx.png)`。

### 自查

录完一批，先跑脱离服务的体检：

```bash
node tools/verify/check-katex.mjs --max-fail=0        # 公式能不能渲染
node tools/import/import-problems.mjs your-batch.json # 质量门禁会标 qualityWarn
node tools/verify/robustness-check.mjs                # 全库体检
```

`qualityWarn` 里的项不会阻断入库，但审核时会被人工追问：定界符奇数、正文里裸着的 `\frac`、题干里出现「答案：」、残留 `tasks` 环境等。

---

## 发布前检查清单

前端零构建，所以没有编译期兜底；这几步是唯一的防线，按顺序走：

1. `npm test` + `npm run test:sqlite`：两条链路都要绿（存储层改动尤其要跑第二条）。
2. `npm run check:robust` + `npm run check:katex`：题库层面 0 错误、0 渲染失败。
3. `SHARECODE=... npm run build:pages`：把 `public/` 同步到 `docs/`（Pages 产物），确认输出的 `apiBase` 与 sharecode 指向正确后端。
4. **浏览器端到端抽查**（`node tools/verify/cdp-eval.mjs "<url>" "<js>"`，或直接开页面看）：
   - 题库列表与题目页公式渲染正常，没有裸 `$`、`\frac` 文字；
   - 移动端窄屏下长公式能横向滚动，不撑破卡片；
   - 投稿页贴图后 OCR 回填的题干可编辑、公式包裹正确；
   - 判卷提交后流式输出不重复、不丢前半段；
   - 审核后台「运行状态」能读到引擎、邮件模式与 AI 通道表。
5. **升缓存串**：改过 `public/` 就必须把 `index.html` 里所有 `?v=` 升到新版本号，否则老用户拿到旧 JS 与新后端打架。
6. 写 `CHANGELOG.md`（面向使用者：症状 → 根因 → 改后行为，数值给出前后对比），再按「数据同步与发布」走 `node tools/ops/deploy.mjs --publish`。

## 提 PR

1. 从 `main` 拉分支，一次 PR 只做一件事。
2. 代码改动附上「为什么」：哪个症状、哪条路径触发的、验证方式是什么。
3. 题库改动说明来源（哪份卷子、哪本书、是否已做查重）。
4. CI 绿了再请 review。

安全问题不要开公开 Issue，直接发邮件或在仓库主页找联系方式。
