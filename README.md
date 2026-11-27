# 数海晴岸（Advanced-Math-Vault）

高等数学好题收藏室。

**主链接（对外分享、发群、写文档都用这个）：<https://hex1um.github.io/Advanced-Math-Vault/>**

- 前端（GitHub Pages）：https://hex1um.github.io/Advanced-Math-Vault/
- 接口服务（仅前端调用，不对外发）：https://math-vault-10141-52003.app.workbuddy.host
- 题目页右上角「复制链接」会拼上面的主链接，不拼当前域名

> 旧实例 `https://math-vault-10141.app.workbuddy.host`（v1.2.1）保留为只读备份：上面还有 14 条做题记录与 5 条待审投稿，
> 因为没有管理员凭据无法迁移，新实例以题库/账号/帖子为准。
仓库：https://github.com/Hex1um/Advanced-Math-Vault

> 「数海晴岸」是站点中文名；仓库名与线上域名仍沿用 `Advanced-Math-Vault`，不影响已有链接。

一个面向高等数学与大学物理的好题收藏站（v3.0.0 起双学科）：**每道题都要人工审核才能进题库**，每题标注「主标签 + 子标签」两级考点与「思维量 / 难度 / 计算量」三个 10 分制维度，全站共享同一份数据（题库、每日一题、答疑区、经验）。华科微积分期中/期末真题带独立来源标签，可在题库按「来源」筛选；《大学数学竞赛教程》的精选练习与附录真题也已导入，并做了全库查重。

## 架构（为什么前端在 Pages、后端在别处）

题库、审核、答疑区、经验必须全站一致，只能用服务端当唯一数据源；GitHub Pages 只能放静态文件，所以拆成两块：

```
GitHub Pages (docs/)  ──fetch + X-MV-Token──>  Node 服务 (server.js + data/db.json)
   静态 SPA                                           唯一数据源
```

- 前端零构建，`public/` 就是站点；`tools/build-pages.mjs` 复制到 `docs/` 并把 `apiBase` 写进 `docs/js/config.js`。
- 鉴权用 **token（localStorage + `X-MV-Token` 头）**，不依赖第三方 Cookie，跨域可用。
- 想换成自己的后端：改 `docs/js/config.js` 里的 `apiBase`（或重建时传 `API_BASE=... SHARECODE=...`）即可。

- 前端：原生 HTML/CSS/JS（无构建、无框架），KaTeX 本地离线渲染公式
- 后端：零依赖 Node HTTP 服务 + JSON 落盘，账号、审核、论坛、AI 代理全在同一进程

## 启动

```bash
node server.js                       # 默认 http://localhost:8787（JSON 存储）
DB_ENGINE=sqlite node server.js      # 行级增量落盘（推荐，Node 22.5+）
PORT=9000 node server.js             # 换端口
```

首次启动会建空库。示例题库在 `data/problems.seed.sample.json`（10 道经典高数题），需要时用 `SEED_FILE=data/problems.seed.sample.json node server.js` 加载。

启动时会打印一段**上线配置提醒**：`ALLOW_ORIGINS` 还是 `*`、没设 `TRUST_PROXY=1`、邮件是日志模式、存储还是 JSON，都会直接点名。同样信息可查：

```bash
curl localhost:8787/api/health            # 免登录：版本 / 引擎 / 邮件模式 / 告警数
curl -b cookie localhost:8787/api/admin/env       # 管理员：完整配置摘要
curl -b cookie localhost:8787/api/admin/ai-stats  # 管理员：AI 通道成功率与耗时
```

当前题库按批次放在 `data/batch-*.json`（合计 6076 道，含 `HS1001` / `PH1001` 起的编号）；运行库 8561 道已通过审核的题——**数学 6562 道、物理 1999 道**，其中**力学 1049 道**。物理侧按「同题型最多留 3 道变式」做过合并（`tools/ops/prune-vault.mjs dedupe`，被合并的题全部归档在 `_archive/vault-cleanup/`），含漆安慎《力学》教材 OCR 录题 195 道与 165 个题族的参数化变式 3278 道；数学侧含华科微积分期中/期末 752 道、大学数学竞赛教程 418 道。每道题含分层提示、答案与分步解析，积分题答案用 sympy 求导校验后入库。

## 账号与审核

- **第一个注册的账号自动成为管理员**（线上已有管理员 `Hex1um`）。
- 也可以在本地用脚本建/重置管理员：`node tools/ops/create-admin.mjs <用户名> <密码>`（需先停服务）。
- 普通用户投稿 → `待审核` → 管理员在「审核后台」核对题干/解析/三维评分、可改标签与分数 → 通过后才进题库；驳回需填原因。
- 投稿通过给作者 +30 经验。
- 「我的记录 → 账号安全」可改密码；改密后其他设备会话失效。
- **做题交思路 + 答案**：写文字（LaTeX 或 `1/2` 这种）或传手写照片，AI 核对后给出「判定 + 分数 + 总评 + 出错位置」，判对才计经验。
  - **最终答案正确且写了简要思路/过程 → 直接 100 分**，中间跳步、省略验算、不够严谨都不扣分；只交正确答案给 80 分；答案错误仍按错步扣分。
  - 答案错误时，错误会具体到「第几步把什么写成了什么」，例如「最后一步回代：$(t-1)e^t$ 应回代为 $2(\sqrt{x}-1)e^{\sqrt{x}}+C$，学生写成了 $2(\sqrt{x}+1)e^{\sqrt{x}}+C$」。
  - 没有可用模型时退化为「只核对结论行的最终答案」，答案正确且写了思路同样给 100 分，并在总评里标注「中间步骤未逐项核对」；只交答案正确给 80 分。
- 做题经验：`10 + 难度×3 + 思维量 + 计算量`；看过答案 ×0.6，问过 AI 再 ×0.8；每题只计一次。

## 考点标签：主标签 + 子标签

题库采用两级考点体系，避免历史自由标签越积越碎：

| 主标签 | 子标签示例 |
|---|---|
| 极限与连续 | 函数极限、数列极限、等价无穷小、夹逼与单调有界、连续与间断、渐近线 |
| 导数与微分 | 导数定义、求导法则、隐函数与参数方程求导、高阶导数、多元函数微分、微分中值定理、泰勒展开、洛必达法则、函数性态与不等式 |
| 积分 | 不定积分、定积分、变限积分、反常积分、二重积分、三重积分、曲线积分、曲面积分、换元与分部、有理函数与三角积分、对称性与周期性、积分不等式、定积分应用 |
| 级数 | 数项级数、幂级数、傅里叶级数、函数展开、收敛判别 |
| 微分方程 | 一阶微分方程、可降阶方程、二阶常系数方程、欧拉方程、初值问题 |
| 线性代数 | 行列式、矩阵运算、逆矩阵与秩、线性方程组、向量组、特征值与特征向量、二次型、相似与对角化、线性空间与变换 |
| 概率统计 | 随机事件与概率、随机变量与分布、多维随机变量、数字特征、极限定理、参数估计、假设检验 |
| 空间解析几何 | 向量代数、平面与直线、曲面与曲线、坐标变换 |
| 综合 | 综合应用 |

- **物理三级分类（v3.1）**：课程组（`course`）→ 主标签（15 个）→ 子标签（99 个）。课程组为 普通物理 / 数学物理方法 / 四大力学 / 天体物理与天文 / 物理实验与实测天文 / 综合；`physicsMeta.course` 可显式覆盖，缺省由主标签推导。题库物理模式顶部按课程组切换，`GET /api/problems?subject=physics&course=theory` 只返回四大力学题。

| 课程组 | 主标签 | 规模 |
|---|---|---|
| 普通物理 | 力学、振动与波、热学、电磁学、光学、近代物理 | 6 章 40 子标签 |
| 数学物理方法 | 数学物理方法 | 1 章 7 子标签 |
| 四大力学 | 理论力学、电动力学、热力学与统计物理、量子力学 | 4 章 29 子标签 |
| 天体物理与天文 | 球面天文与天体力学、天体物理基础 | 2 章 14 子标签 |
| 物理实验与实测天文 | 物理实验与误差分析 | 1 章 6 子标签 |

- **教材原图（v3.4）**：`physicsMeta.diagrams` 支持教材扫描件裁出的 WebP（`tb-<题号>-p<页>-<序>.webp`，当前 21 张在用），题页按白名单渲染为 `<img>` 并支持点击放大。裁图流程见 `tools/import/ocr-textbook.md` 第 4 节：OCR 文本框 + 连通域分离图与文字，再用「题 x.y.z 图」标签自动配对，产出后必须视觉抽检。
- **物理判题支持多单位制**：`physicsMeta.unitSystem` 取 `SI`（默认）/ `CGS`（高斯制，电磁量不校验电流维）/ `astro` / `natural`；`answerType: "order_of_magnitude"` + `tolDex` 用于天文量级估算（`0.3 dex` ≈ 2 倍以内判对）。常数速查栏可切 SI / CGS / 天文三套口径。
- **物理是独立命名空间**：题目带 `subject: "physics"`，主标签换成力学 / 振动与波 / 热学 / 电磁学 / 光学 / 近代物理 / 物理实验与误差分析（+ 兜底「综合」），共 99 个子标签。数学与物理的标签表互不重叠，`GET /api/problems?subject=physics` 只返回物理题，不传 `subject` 仍按数学处理。

| 物理主标签 | 子标签示例 |
|---|---|
| 力学 | 质点运动学、牛顿定律与非惯性系、动量与碰撞、功与机械能、万有引力与天体运动、刚体定轴转动、刚体平面平行运动、角动量守恒、流体力学基础、弹性体的应力与应变 |
| 振动与波 | 简谐振动、阻尼与受迫振动、振动合成、平面简谐波、波的干涉与驻波、多普勒效应 |
| 热学 | 理想气体状态方程、气体动理论、麦克斯韦速率分布、热力学第一定律、循环过程与卡诺循环、热力学第二定律与熵 |
| 电磁学 | 静电场与高斯定理、电势与电容、静电场中的导体与电介质、恒定磁场与安培环路定理、洛伦兹力与安培力、电磁感应与自感互感、麦克斯韦方程组与电磁波 |
| 光学 | 几何光学与薄透镜成像、光的干涉、光的衍射、光的偏振 |
| 近代物理 | 狭义相对论时空观、相对论动力学、黑体辐射与光电效应、康普顿散射、玻尔氢原子模型、德布罗意波与不确定关系、一维定态薛定谔方程、原子核与激光基础 |
| 物理实验与误差分析 | 测量误差与不确定度合成、有效数字与修约、逐差法与最小二乘法、薄透镜焦距测量、分光计与光谱测量、电桥与示波器测量 |
- 每题只有一个 `mainTag`，`tags` 存 1-3 个子标签；`kind` 单独存「选择题 / 填空题 / 证明题 / 应用题 / 概念题」。
- 定义在根目录 `tag-taxonomy.js`，服务端启动时会把旧库里的自由标签自动归并；`tools/migrate-tags.mjs` 可批量迁移 `data/batch-*.json` 与 `data/db.json`。
- 历史标签里「高等数学」「线性代数」「概率论」这类章节名、以及题型词会从 `tags` 移除（章节名归入主标签，题型词归入 `kind`），不再占用考点位。

## 批量导入题目

题目字段：

```json
{
  "title": "标题（支持 $LaTeX$）",
  "statement": "题干，行内 $...$，独立 $$...$$",
  "mainTag": "导数与微分",
  "tags": ["等价无穷小", "泰勒展开"],
  "thinking": 6,
  "difficulty": 6,
  "calc": 5,
  "source": "同济《高等数学》习题改编",
  "hints": ["第一层提示", "第二层提示"],
  "answer": "$\\frac{1}{2}$",
  "solution": "分步解析（Markdown + LaTeX）"
}
```

三种导入方式：

1. 审核后台 → 「批量导入题目」粘贴 JSON 数组；
2. 同上，点「选择 JSON 文件」直接读文件；
3. 命令行（服务已停止时写库）：`node tools/import/import-problems.mjs data/batch-01.json`
   或服务运行中走接口：`node tools/import/import-problems.mjs data/batch-01.json --url http://localhost:8787 --user 管理员 --pass 密码`

加 `--verify` 会先跑符号/数值校验再入库，并给「自动验算不了」的题打 `needsReview` 标记，审核后台会显示「待验算：原因」：

```bash
node tools/import/import-problems.mjs data/batch-05.json --verify   # 导入 + 门禁
node tools/import/gate.mjs data/batch-05.json                        # 只预览会被标哪些题
```

编号自动分配：`HS1001`、`HS1002`……

## AI 通道（四级自动降级）

右上角「设置」可以填自己的 Key（只存本机 localStorage）；站点本身**不内置任何 Key**，按下面的顺序自动挑一个可用通道：

| 顺序 | 通道 | 说明 |
|---|---|---|
| 1 | 用户自带 Key | 对话里点「模型」填 OpenAI 兼容 Key，只存本机浏览器，不写数据库 |
| 2 | 站点 Key | 审核后台填写（可选，全站共用） |
| 3 | 免费公共通道 | Pollinations（`openai-fast` → `openai`）。**由浏览器直连**，用访客自己的 IP 额度，不挤在一台服务器上；同一网络 45 秒一次 |
| 4 | 本地讲解 | 内置引擎：按考点给思路骨架 + 分层提示 + 标准解答 |

界面左下角实时显示当前通道（`我的 Key` / `站点模型` / `免费通道 · 本机直连` / `本地讲解`）。
免费通道限流或超时（服务端 22 秒、浏览器直连同步降级），已输出的内容不会重复。

所有 `/api/ai/*` 接口都要登录。服务端只向 `https` 的域名白名单发请求：默认允许 DeepSeek、OpenAI、智谱、通义、Gemini、Anthropic、Groq、OpenRouter、Moonshot、MiniMax、Pollinations 等公开服务；裸 IP、`localhost`、`.local` / `.internal` 域名与非 443 端口一律拒绝，query/hash 会被丢弃。需要接自建域名时用环境变量 `LLM_ALLOWED_HOSTS=host1,host2` 扩展（只填域名，不带协议）。

### 高数专家模式

对话默认开启，system prompt 固化了一套解题范式：**审题 → 定位考点 → 选策略（说明为什么不用另一条路）→ 分步执行 → 验算 → 易错点**，
并把题库里同考点题目的题干与提示作为参考资料一起喂进去（只给题干和提示，不给答案，避免照抄）。
这不是微调模型：没有算力也没有标注数据，靠的是「领域提示词 + 题库检索」把通用模型约束成高数助教。

## AI 出题

`AI 出题` 页先选 1 个主标签，再选 1-2 个子标签，配合难度、计算量、题型生成题干/答案/分步解析；结果可编辑后提交审核。
- 走同一套通道链；无 Key 时浏览器直连免费通道，服务端只提供提示词与结果校验（`/api/ai/prompt`、`/api/ai/parse`）。
- 生成的是**草稿**，入库仍要人工核对——实测免费模型会算错（例如把 `∫x²sech²x dx` 答成 π²/8，正确是 π²/12）。
- 限流：站点出题接口每小时 12 次（同一 IP）；浏览器直连免费通道另有「同一网络 45 秒一次」的冷却。

启动时想用固定 Key 也可以：

```bash
LLM_BASE_URL=https://api.deepseek.com/v1 LLM_MODEL=deepseek-chat LLM_API_KEY=sk-xxx node server.js
```

## 目录

```
server.js                 组合根：配置 / 存储 / 上下文 / 路由挂载 / 生命周期（约 230 行）
lib/core.js               业务核心：数据层、判题、AI 装配、上传、答疑与反馈
lib/context.js            统一上下文（ctx.db 实时 getter、ctx.saveDb、ctx.services）
lib/router.js             零依赖路由器（:param / 通配 / 洋葱中间件 / POST 限流）
lib/migrations.js         SQLite 版本化迁移（schema_meta.version 驱动，逐步事务）
lib/math-equiv.js         数学表达式数值等价判定（判题兜底，不用 eval）
lib/circuit-breaker.js    AI 通道三态熔断 + EMA 延迟排序
lib/store.js              存储层：JSON 全量写 / SQLite 行级增量写，双引擎可切
lib/mail.js               邮件通道：SMTP / Resend / 自建 HTTP / 日志降级
lib/env.js                部署目录 .env 加载（不覆盖平台环境变量）
routes/*.js               按域拆分的接口：health / auth / practice / wrongbook / analytics /
                          forum / paper / me / ai / admin / collections / problems
tag-taxonomy.js           主标签 / 子标签定义与历史标签归并规则
.env.example              全部环境变量与含义（含 TRUST_PROXY、ALLOW_ORIGINS、邮件、存储）
data/batch-*.json          分批题库（约 2470 道）
data/problems.seed.sample.json  示例题库（默认不加载）
data/db.json              运行时数据库（自动生成，不入库）
data/backups/             启动快照与每日备份（保留 12 份 / 14 天）
public/index.html         单页外壳
public/assets/style.css   全部样式
public/js/api.js          fetch 封装
public/js/md.js           Markdown + LaTeX 渲染
public/js/ui.js           头部 / Toast / 模态框 / 分页 / 评分条
public/js/app.js          路由
public/js/views/*.js      题库 / 题目 / 每日一题 / 答疑区 / 投稿 / 我的 / 审核 / AI 对话
public/js/views/sprint*.js 期末突击：科目选择页 + 工作台（学习 / 薄弱 / 背单词）
lib/sprint.js             科目包加载、判分、薄弱度算法、词库与 FSRS 排期、AI 提示词
routes/sprint.js          期末突击 12 个接口（科目 / 判分 / 薄弱 / 背单词）
data/subjects/*.json      科目包（学校-科目-学年）
data/subjects/vocab/*.json 四六级词库（词 / 音标 / 词性 / 释义 / 例句 / 同义）
public/js/heatmap.js      刷题热力图（纯 SVG，无图表库）
public/js/draft-store.js  防丢稿草稿箱（7 天 TTL）
public/js/ocr-preprocess.js 笔记本横线擦除与阴影抬升（OCR 预处理）
Dockerfile                零依赖容器镜像（node:22-alpine + 数据卷 + HEALTHCHECK）
public/vendor/katex/      本地 KaTeX（离线可用）
tools/README.md           脚本分层说明与新增脚本的规矩
tools/ops/                部署 / 同步 / 备份 / 回流 / 迁移
tools/verify/             冒烟、体检、公式、存储/邮件/.env 自测、符号校验
tools/import/             导入、数据规范化与入库门禁（gate.mjs）
```

## 期末突击（v2.1.0）

题库回答的是「这道题怎么解」，期末突击回答的是「这门课的考点怎么过」。入口在顶部导航「期末突击」。

```
#/sprint                       选学校 · 科目 · 学年
#/sprint/<packId>              工作台：学习知识点 / 分析薄弱
#/sprint/<packId>?tab=vocab    有词库的科目（四六级）再多一个「背单词」
```

一个**科目包**（`data/subjects/*.json`）= 学校 + 科目 + 学年 + 考试蓝图 + 章节/考点 + 题目，与数学题库分开存放：

| 字段 | 说明 |
|---|---|
| `exam.sections` | 题型 / 题量 / 每题分值 / 总分，页面顶部按它显示「单选 10×2=20′」 |
| `chapters[]` | 章节，`weight` 越高越该先看 |
| `points[]` | 考点：`core`（一句话结论，背诵版）、`detail`（展开）、`keys`、`examTypes`、`frequency`、`traps` |
| `questions[]` | 内联题（政治类）或 `{ "ref": "HS1234" }`（引用题库真题） |
| `vocabFile` | 可选，指向 `data/subjects/vocab/*.json`；有它才出现「背单词」Tab |
| `allowUsers` | 可选，账号白名单。写了就只有这些账号能在列表/接口里看到这个包，其他人一律 404 |

**学习知识点**：左侧章节树选考点 → 一句话结论 / 展开 / 关键词 / 易错点 → 「AI 讲解」「找类似题」「AI 再出 3 道」。
找类似题三级：包内真题 → 包内自编题 → AI 出题，前端标出哪几道来自往年卷。
客观题（单选/判断）点选即判分并记入进度；填空题「提交答案」自动判（忽略空白标点，多空/多小问都支持，
部分命中显示百分比但不判对）；简答/论述/材料分析不硬判，给分条得分点自评，也能让 AI 按评分标准批改。

**分析薄弱**：按考点聚合「错题率 + 提问次数 + 直接看答案次数」，算出 0-100 的薄弱度（练够 3 次且正确率 ≥85% 的会压到低分区），
给出章节维度的「薄弱板块」和考点排序；「生成突击方案」按薄弱度排 3 天任务，没配模型时用规则版，配了就走 AI 版。

**背单词**（四六级）：卡片先显示单词、音标、词性，空格/点击看释义（例句 + 同义词），
然后三档自评「不认识 / 模糊 / 认识」，分别映射到错题本同一套 FSRS 的 `again / hard / good`。
「不认识」的词插回三张之后重来，「模糊」的放到本轮末尾再过一遍，各自最多两次，一轮 20 张能走完；
不想评价的词可以「跳过」，不计分也不改排期。
模式分「混合 / 只复习 / 只背新词」；「速览模式」直接展开释义，适合纯过眼。
新词按**单词哈希**排序出队（不是词库字母序，否则永远从 A 段背起），同一份已学集合永远给出同一批词，跨天可续。
统计行有「词库 / 已学 / 待复习 / 未学 / 今日」，今日按东八区日期翻页。
进度存在 `db.sprint[uid][packId].vocab`，换设备跟着账号走。

现有科目包：

| 包 | 考点 | 题量 | 词库 | 题目来源 |
|---|---:|---:|---:|---|
| `hust-xigai-2026` 华科 · 习概 2026 | 97 | 168 | — | 按 17 章重点自编（单选/判断/简答/论述/材料分析），每题带解析 |
| `hust-calculus-b-2026` 华科 · 微积分（B）2026 | 35 | 120 | — | 题库里的华科历年期中/期末真题，按章节标签挂接 |
| `hust-c-2026` 华科 · C 语言程序设计 2026 | 30 | 72 | — | 2020–2022 三套真题（含 12 道原文）+ 按考点自编；题型对齐「表达式求值/改错/简答/程序分析/程序完善」 |
| `hust-english-2026` 华科 · 综合英语（一）2026 | 26 | 49 | — | 参照公开的 2025 级 A 卷结构自编（阅读、选词填空、翻译、写作范文） |
| `cet4-2026` 全国 · 大学英语四级 | 32 | 31 | 1162 | 按官方题型自编；写作 106.5 + 听力 248.5 + 阅读 248.5 + 翻译 106.5（总分 710） |
| `cet6-2026` 全国 · 大学英语六级 | 31 | 31 | 1228 | 同上，听力含讲座/讲话 10 题，写作 150–200 词、翻译 180–200 字 |
| `hust-tuanyuan-2026` 华科 · 入团积极分子培训（结业考试） | 33 | 60 | — | 按培训复习重点五部分整理，**仅 `Hex1um` 可见** |

加一门新科目：

```bash
# 手写：照 data/subjects/hust-xigai-2026.json 的结构写一份，改 id/school/subject/year
# 引用题库真题的（数学类）：维护 tools/import/build-calculus-pack.mjs 里的章节映射表后重跑
node tools/import/build-calculus-pack.mjs --write
# 体检：考点/题量/答案合法性/引用是否命中
node tools/verify/calc-pack-test.mjs
```

科目包是只读的，学生的答题与提问记录写在 `db.sprint[uid][packId]`（跟着账号走，换设备不丢）。

**私有科目包**：在包里写 `"allowUsers": ["Hex1um"]`，这个包就只对名单里的账号出现。
隔离在服务端完成——列表按账号过滤，其余接口统一走 `sprint.getFor(id, user)`，
无权访问与不存在一样返回 404（不泄漏包名和考点数），列表只回一个 `private: true` 给前端打「仅你可见」。

## 每日一积：伪随机与连排

默认按日期哈希在全库里伪随机选题（`lib/core.js` 的 `dailyProblem()`），并排除最近 30 天出过的题。

需要「这几天按顺序出某几道题」时，改 `lib/daily-plan.js` 就行：

```js
module.exports = {
  start: '2026-11-26',           // 从这天开始算第 1 题
  codes: ['HS7542', 'HS7543']    // 按顺序一天一道，走完自动回到伪随机
};
```

- 连排优先级高于伪随机、低于管理员在后台指定的单日题目（`db.dailyOverride`）。
- 排期里写错的题号（不存在/未过审）会被跳过并打日志，当天回落到伪随机，不会出现空白页。
- `node tools/verify/daily-plan-test.mjs` 体检：题号是否都在库里、是否过审、是否互不重复、日期换算是否正确（跨月、越界）。
- 出过的题会写进 `db.daily[日期]`，所以首页的「往期」和历史统计照常。

2026-11-26 起的排期是一份 20 道不定积分练习单（19 道新入库 HS7542–HS7560，
第 4 题库里本就有，直接用 HS6509），每道题都带答案、分步解析和三条提示。

## 存储：JSON 与 SQLite 双引擎

题库到 6000+ 题后，每次保存都 `JSON.stringify` 整个库再 fsync，会阻塞单线程事件循环；单文件也没法多实例共享。`DB_ENGINE=sqlite` 换成行级增量落盘：

- 内存里仍是同一个 `db` 对象，用 Proxy 记录「哪条被改」，保存时只 UPSERT 变化的行；导入、删除这类结构性变化才重建该表。
- 表结构是「索引列 + body(JSON)」：`problems(code, status, main_tag, sub_tag, difficulty, body)`，另有 `users / posts / submissions / feedbacks / daily / sessions / email_codes / kv`，索引覆盖主标签筛选、用户提交、待处理反馈等常用查询。
- 每 50 次保存做一次行数对账，对不上就整表重建，防止 Proxy 漏记导致静默丢数据。
- 仍按 `DB_MIRROR_JSON`（默认 5 分钟 + 关机时）导出 `db.json`，`sync-live` / `deploy` / `robustness-check` 这些按 db.json 工作的老流程不用改。

迁移与验证：

```bash
node tools/ops/migrate-json-to-sqlite.mjs          # 导入并逐行比对
node tools/ops/migrate-json-to-sqlite.mjs --dry    # 只看会做什么
node tools/verify/store-test.mjs                   # 增量落盘 / 重载一致性自测
npm run test:sqlite                                # 全链路冒烟（SQLite 引擎）
```

## 邮件：验证码真正发出去

`sendMailCode` 走 `lib/mail.js`，按环境变量自动选通道，都不配则退回日志模式（本地开发零门槛）：

| 配置 | 通道 |
|---|---|
| `SMTP_HOST` + `SMTP_PORT` + 账号密码 | 标准 SMTP（587 STARTTLS / 465 TLS，零依赖实现） |
| `RESEND_API_KEY` | Resend HTTP API |
| `MAIL_HTTP_URL`（+ `MAIL_HTTP_TOKEN`） | 自建 HTTP 邮件网关 |
| 都不配 | 日志模式，验证码只写服务端日志 |

发验证码本身也有限流（每 IP 每小时 6 次），避免被拿来刷别人邮箱。`node tools/verify/mail-test.mjs` 用本地假 SMTP 服务器验证整条链路，不需要真实凭据。

## 备份与题库回流

- **启动快照**：每次启动把现有 `db.json` 拷到 `data/backups/`，保留 12 份。
- **每日归档**：进程内每 30 分钟检查是否跨天，跨天就把库归档到 `data/backups/daily/`，保留 14 天（`BACKUP_KEEP` 可调）。SQLite 引擎下先 `wal_checkpoint` 再拷文件，并同时留一份 JSON。
- **手动备份**：`node tools/ops/backup-db.mjs --label before-import`。
- **题库回流**：`node tools/ops/export-batch.mjs`（先只报告），确认后加 `--write` 生成下一个 `data/batch-NN.json`；按「标题 + 题干」去重，只导题本体，作者统一写「题库组」，不带做题统计与审核人。

## 组卷与计时模考

- 组卷页的「智能组卷」按考点轮转抽题（尽量覆盖多个主标签），难度按 30% / 50% / 20% 配额，可限定考点、题量、时长；生成结果是本地区列表，可直接打印。
- 「开始模考」进入 `#/exam`：倒计时（最后 5 分钟变红）、答案自动保存在 localStorage（刷新不丢）、进度条、交卷前未答提醒、时间到自动交卷。
- 交卷判分：选择题 / 填空题按答案等价自动判（`/api/exam/grade`），解答题标「待自评」并给回原题链接；接口不回传正确答案，答案仍只在原题的 `/reveal` 里给。
- 题型判定 `problemKind()`：标题优先，其次看答案形态（短答案且不含「证明/构造/略」视为填空题），所以历史题即使没标题型也能自动判分。

## 错题本与间隔重复（FSRS）

- 错题按稳定度 / 难度排期（`lib/fsrs.js`，确定性实现）：判错把稳定度腰斩、难度上调，首次做错立刻进今日复习；答对按「良好」推进，间隔到 8 天自动出本。
- 每行可以直接自评「忘了 / 吃力 / 良好 / 简单」（`POST /api/wrongbook/:code/review`），也可以写一句错因备注（`POST /api/wrongbook/:code/note`，不影响排期）。
- 今日复习按「逾期越久越优先、稳定度越低越优先」排序。

## 离线与安装（PWA）

`manifest.json` + `sw.js`：`/api/` 与 `/uploads/` 永远走网络（缓存接口会导致登录态错乱），页面导航网络优先、断网回退缓存，静态资源 stale-while-revalidate；缓存名带版本号，升级自动清旧缓存。

## 测试

```bash
npm test                             # 冒烟 190 项断言 + 全部门禁（CI 跑的就是这条；本地要快用 test:quick）
npm run test:quick                   # 只跑冒烟（JSON 引擎）：注册/改密/审核/做题/AI/论坛/两级标签/权限与安全
npm run test:sqlite                  # 同一套冒烟断言，跑在 SQLite 引擎上
npm run check:all                    # 门禁合集：lint + 7 个内容/前端门禁 + 判题 fuzz（一条命令跑完）
npm run lint                         # 零依赖 lint：no-var / eqeqeq（放行 == null）/ 全量语法检查

# 单项门禁（CI 的 smoke.yml 直接调用这些名字，所以它们必须保留；其余脚本见下）
npm run check:store                  # 存储层：导入、增量落盘、重载一致性（含 Map 主键/精确增删/对账口径）
npm run check:mail                   # 邮件通道（本地假 SMTP）
npm run check:env                    # .env 解析与「不覆盖已有变量」
npm run check:robust                 # 题库体检（没有 db.json 时自动读 batch 题库）
npm run check:ops                    # 管理员一次性重置机制
npm run check:http                   # 路径穿越 / TRUST_PROXY / 500 脱敏 / 限流桶上限 / CORS 组合
npm run check:md                     # Markdown 渲染、XSS 链接白名单、行内代码与公式边界
npm run check:mathkey                # 公式键盘的光标环境状态机
npm run check:equiv                  # 数学等价判题引擎（半角公式 / 对数合并 / 不定积分差常数）
npm run check:delims                 # 公式定界符与环境闭合门禁（CI 严格模式）
npm run check:physics-equiv          # 物理判题引擎（单位换算 / 量纲 / 容差 / 有效数字）
npm run check:physics-gate           # 物理题内容门禁（标签体系 / 配图安全 / 标准答案自检）

# 不进 check:all 的病种（需要真实库或产物目录，按需单独跑）
node tools/verify/check-katex.mjs --max-fail=0                  # 公式可渲染性，必须 0 失败
node tools/verify/check-answer-leak.mjs                         # 未解锁用户拿不到标准答案
node tools/verify/components-test.mjs                           # 前端公共组件
node tools/verify/fsrs-test.mjs                                 # 错题本 FSRS 调度器
node tools/verify/calc-pack-test.mjs                            # 期末突击科目包（需要 data/db.json）
node tools/verify/daily-plan-test.mjs                           # 每日一积连排表（需要 data/db.json）
node tools/verify/fuzz-equiv.mjs                                # 判题引擎 fuzz（长度/深度/随机输入）
node tools/verify/dedup-problems.mjs --self-test                # 查重工具自检
npm run ops check-pages                                         # Pages 产物自检（先 build-pages）
npm run verify:physics -- --file data/batch-physics-01.json     # SymPy 量纲与单位自洽校验
npm run ops diagrams -- --list                                  # 专业示意图模板 + 物理内容门禁

# 教材扫描件录入（需本机装 pymupdf + rapidocr-onnxruntime）
python _ocr/ingest.py toc            # 打印书签目录，定位各章「习题」页
python _ocr/ingest.py chapter 7      # OCR 第 7 章习题段
python _ocr/figures.py scan 154 156  # 检测题图区并打印匹配到的题号（不落盘）
python _ocr/figures.py cut 154 156   # 裁图写入 public/assets/diagrams/physics/
node tools/verify/check-physics-gate.mjs    # 入库门禁：标签 / 配图 / 标准答案自检
python tools/verify/verify_physics.py --file data/batch-physics-12-textbook-mech3.json
node tools/diagrams/make-svg.mjs     # 重新生成 public/assets/diagrams/physics/physics-*.svg
```

**脚本入口只有三个**（v3.12.0 从 49 条 scripts 收敛到 26 条，其中 14 条是 CI 直接调用的）：

```bash
npm test          # 冒烟 + 全部门禁
npm run ops <动词>      # 运维：deploy / backup / admin / build-pages / sync / export-batch / prune …
npm run import <动词>    # 录题：problems / gate / tags / contest / hust / calc-pack …
```

`npm run ops`（不带动词）会把子命令表打出来。

```bash
python tools/verify/verify_integrals.py [--file x.json]   # 逐题对答案求导，数值双点验证
python tools/verify/verify_limits.py    [--file x.json]   # 极限题数值验证（高精度）
node tools/import/gate.mjs data/xxx.json --strict         # 入库门禁：符号校验 + KaTeX + 标签/评分/占位词
node tools/verify/dedup-problems.mjs --threshold=0.85     # 题库查重（4-gram Jaccard）
node tools/verify/dedup-problems.mjs --strict             # 有疑似重复就非零退出，可挡在导入之前
node tools/import/migrate-tags.mjs                        # 只报告标签迁移结果；加 --write 才写盘
```

CI 见 `.github/workflows/smoke.yml`：push / PR 到 `main` 自动跑上面这串（外加 sympy 符号校验 job），不需要装任何 npm 依赖。
`.github/workflows/pages.yml` 在 CI 内从 `public/` 现场构建并直接发布产物——`docs/` 不再提交进 `main`，
所以改前端只会 diff `public/`。

> 录题纪律：每道积分的答案都先用 sympy 求导验证再入库，`verify_integrals.py` 里保留了对应用例，新增题目时追加即可。

## 上线配置（反代与跨域）

线上后端跑在托管网关后面，有两项配置不设就会静默降级：

| 变量 | 不配的后果 |
|---|---|
| `TRUST_PROXY=1` | 所有用户共用代理 IP 的限流额度（登录 12 次/分、AI 40 次/10 分、投稿 20 次/10 分），人多时互相顶掉 |
| `ALLOW_ORIGINS=https://hex1um.github.io` | 默认 `*`，任何站点都能带凭据调用接口 |

`TRUST_PROXY` 只在「最外层就是自己的代理」时开：`clientIp()` 依赖 `X-Forwarded-For` 首段，代理没覆盖写这个头时，客户端可以伪造它换限流桶。启动日志与 `/api/health` 都会提示当前状态；管理员在「审核后台 → 运行状态」里能看到完整摘要与告警列表。

### 限流的三个已知盲区（多实例部署前务必看）

内置限流是**进程内内存计数**，用途是「挡住手滑和脚本」，不是抗 DDoS：

| 盲区 | 表现 | 应对 |
|---|---|---|
| 只管 POST | 刷 `/api/problems` 列表与详情（GET）没有任何配额 | 由反代层按 IP 做粗粒度 QPS 限制 |
| 计数在进程内存里 | 起两个实例 / 容器横向扩容，配额直接翻倍；重启清零 | 多实例时把限流交给反代或网关（nginx `limit_req`、云 WAF） |
| 未登录用户按 IP 分桶 | NAT / 校园网出口后面的所有用户共享一份额度 | 部署 `TRUST_PROXY=1` 并让代理透传真实 IP |

接口级的精确额度（登录 12 次/分、AI 40 次/10 分等）写在 `lib/core.js` 的 `RATE_RULES`，改那里即可。

托管平台没有环境变量面板时，用部署目录里的 `.env`（`server.js` 启动会读，且不覆盖平台已有变量）：

```bash
cp .env.production.example .env    # 填 SMTP、Key 等
node tools/ops/deploy.mjs --preflight-only   # 只检查配置，不上传
node tools/ops/deploy.mjs --publish
```

`.env` 不会进 git；`tools/ops/deploy.mjs` 会在发布前检查 `TRUST_PROXY` / `ALLOW_ORIGINS`，没配就先把风险点打出来。其余变量见 `.env.example`。

### Pages 的 Source 必须是「GitHub Actions」

仓库不再提交 `docs/`（已 gitignore），由 `.github/workflows/pages.yml` 从 `public/` 现场构建并发布。
如果仓库设置里 Pages 的 Source 还是「Deploy from a branch → main /docs」，旧版构建器每次都会失败
（找不到 docs 目录）并与 Actions 抢发布，表现为「工作流成功但站点看起来没更新」。
设置路径：Settings → Pages → Build and deployment → Source 选 **GitHub Actions**
（或用 API `PUT /repos/{owner}/{repo}/pages` 传 `{"build_type":"workflow"}`）。

### 前端指向哪个后端：`deploy.config.json`

`apiBase` 与 `sharecode` 必须**成对**，所以它们放在仓库内的 `deploy.config.json`，由 `build-pages.mjs` 读取：

- CI 的 `pages.yml` 里也有这两个值，但工作流文件需要 `workflow` scope 才能改；历史上有一次「env 指到新实例、分享码还是旧实例的」，
  结果 Pages 上每个接口都 403。现在以仓库文件为准：env 里的 `API_BASE` 只有在**与文件不一致**（确实换后端）时才生效，并要求同时给 `SHARECODE`。
- 构建前会真实请求一次 `/api/health?sharecode=`，返回 401/403 直接让构建失败（`SKIP_BACKEND_PROBE=1` 可跳过）。
- 改完 `deploy.config.json` 记得同时动一下 `public/` 里的文件（例如版本串）或手动触发一次 Pages 工作流，
  因为 `pages.yml` 的 `paths` 没包含这个文件——这是刻意的：避免只改配置就把线上切走。

> 注意：`SHARECODE=... ADMIN_PASS=... node ...` 是 Git Bash / POSIX 写法。PowerShell 里要写成
> `$env:SHARECODE="..."; $env:ADMIN_PASS="..."; node tools/ops/deploy.mjs --publish`，
> 否则 PowerShell 会把 `SHARECODE=...` 当成命令名，报 `CommandNotFoundException`。

## 忘了管理员密码怎么办

站点没有「找回密码」入口（未接邮件闭环时也不该有），用部署目录里的**一次性文件**重置：

1. 在项目根建 `data/ops/reset-admin.json`（该目录已被 gitignore）：
   ```json
   { "name": "Hex1um", "password": "新密码（≥8位）", "token": "16位以上随机串" }
   ```
2. 发布一次（`node tools/ops/deploy.mjs --publish`）；服务冷启动时读取该文件、改掉密码、清空该用户所有旧会话，然后**删除文件**并在日志打印 `[ops] 已重置 … 的密码`。
3. 用新密码登录，立刻在「我的记录 → 账号安全」改成自己的密码。
4. 确认 `data/ops/reset-admin.json` 已消失；若失败会改名为 `.failed` 并保留原文，日志里有原因（缺 token、密码太短、用户不存在）。

安全边界：能写部署目录的人本来就能控制这台服务器，所以这不是新增的越权面；但缺 token 或字段不合规时一律不动库。

## 数据同步与发布

发布一律用 `node tools/ops/deploy.mjs`：它先把线上用户、帖子、反馈、提交记录、每日记录合并回本地库，再上传，避免本地 `data/db.json` 覆盖线上数据。`--no-sync` 现在默认拒绝，只有显式 `ALLOW_NO_SYNC=1` 才能跳过。

脚本已移除内置的生产凭据，运行前必须显式提供：

```bash
SHARECODE=... ADMIN_PASS=... node tools/ops/deploy.mjs --publish
# 只看差异、不写盘：
SHARECODE=... ADMIN_PASS=... node tools/ops/sync-live.mjs --dry
# 不想在命令行留明文密码，就用会话令牌（浏览器登录站点后 localStorage.getItem('mv_token')）：
SHARECODE=... ADMIN_TOKEN=... node tools/ops/deploy.mjs --publish
```

> 登录被拒（401）时的三种常见原因：密码填成了示例占位文本、管理员用户名不是 `Hex1um`（用 `ADMIN_USER` 改）、`ADMIN_TOKEN` 已过期。`429` 是同 IP 每分钟 12 次的登录限流，等一分钟即可。

**凭据放哪**：不要写进 `.env` —— 部署会把整个目录上传到实例，`.env` 也跟着上去，等于把管理员口令明文放进线上文件系统。放在项目目录之外，`deploy.mjs` 会自动读：

```bash
# 一次性写好（Windows 下路径是 C:/Users/<你>/.math-vault-deploy.env）
cat > ~/.math-vault-deploy.env <<'EOF'
SHARECODE=...
ADMIN_USER=Hex1um
ADMIN_PASS=...
EOF
node tools/ops/deploy.mjs --publish      # 不用再手传环境变量
```

也支持 `DEPLOY_CRED_FILE=/path/to/file` 指定别的文件；环境变量里已有的值优先，不会被文件覆盖。

- `SHARECODE` 或 `ADMIN_PASS` 缺失时，`tools/ops/sync-live.mjs` 直接报错退出（退出码 2），不再回退到任何默认值。
- `tools/ops/deploy.mjs` 默认只同步、不发布；发布必须加 `--publish`（或 `USER_ASKED_TO_PUBLISH=1`），避免误触发线上覆盖。
- **`SHARECODE` 是托管网关的公开访问码**，必须随前端发布，所以会出现在 `docs/js/config.js`；它不是管理员密码，也不应该被当成密钥。管理员密码只通过 `ADMIN_PASS` 环境变量传入。
- `tools/build-pages.mjs` 不再内置 sharecode 默认值，重建 Pages 时必须显式传 `SHARECODE=...`。
- 历史版本曾把管理员密码写进源码。若线上管理员密码曾在旧提交中出现过，请轮换密码，并用 `git filter-repo` / BFG 清理历史；sharecode 则可以按公开访问码处理。
- 凭据只通过当前命令的环境变量传入，不要写进仓库、截图或日志。

## 设计说明

- **为什么不用 WebRTC**：需求是「每个用户看到的都一样」。P2P 只有在房间内有人在线时才能同步，论坛帖子和审核结果会随节点离线而丢失；改成服务端单一数据源后，任何设备、任何时间打开都是同一份内容。P2P 适合实时对战（如 BORDER OPS），不适合作为论坛的持久化真相。
- 所有响应 `Cache-Control: no-store`，静态资源引用带版本号，避免移动端缓存旧代码。
- 密码 scrypt 加盐哈希，会话为 HttpOnly Cookie（30 天）；HTTPS 下自动加 `Secure`。
- 限流：登录/注册 12 次/分、改密 6 次/分、AI 问答 40 次/10 分、投稿与发帖 20~30 次/10 分（按 IP）。默认忽略 `X-Forwarded-For`（客户端可伪造它绕过限流）；只有部署在可信反向代理后并设置 `TRUST_PROXY=1` 时才按 XFF 首段分桶。
- 审核后台可「导出全部数据」（题库 + 帖子 + 每日一题记录，不含账号密码），用于重新部署前备份线上数据。
- 题目反馈卡片支持管理员直接改题干/答案/解析，或删除题目；删题会清理每日一题、用户做题记录和帖子关联。
- **注意**：不要用本地 `data/db.json` 手工覆盖线上数据；发布走 `node tools/ops/deploy.mjs`（见「数据同步与发布」）。
