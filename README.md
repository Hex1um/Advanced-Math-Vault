# 数海晴岸（Advanced-Math-Vault）

高等数学好题收藏室。

线上地址：**https://hex1um.github.io/Advanced-Math-Vault/** （前端，GitHub Pages）
接口服务：https://math-vault-10141.app.workbuddy.host （后端，Node 单进程）
仓库：https://github.com/Hex1um/Advanced-Math-Vault

> 「数海晴岸」是站点中文名；仓库名与线上域名仍沿用 `Advanced-Math-Vault`，不影响已有链接。

一个面向高等数学的好题收藏站：**每道题都要人工审核才能进题库**，每题标注「主标签 + 子标签」两级考点与「思维量 / 难度 / 计算量」三个 10 分制维度，全站共享同一份数据（题库、每日一题、答疑区、经验）。华科微积分期中/期末真题带独立来源标签，可在题库按「来源」筛选；《大学数学竞赛教程》的精选练习与附录真题也已导入，并做了全库查重。

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
cd math-vault
node server.js          # 默认 http://localhost:8787
PORT=9000 node server.js  # 换端口
```

首次启动会建空库（`data/db.json`）。示例题库在 `data/problems.seed.sample.json`（10 道经典高数题），需要时用 `SEED_FILE=data/problems.seed.sample.json node server.js` 加载。

当前题库按批次放在 `data/batch-*.json`（合计约 2400 道，含 `HS1001` 起的编号）；本地运行库约 6400 道已通过审核的题；其中华科微积分期中/期末 752 道、大学数学竞赛教程 418 道。每道题含分层提示、答案与分步解析，积分题答案用 sympy 求导校验后入库。

## 账号与审核

- **第一个注册的账号自动成为管理员**（线上已有管理员 `Hex1um`）。
- 也可以在本地用脚本建/重置管理员：`node tools/create-admin.mjs <用户名> <密码>`（需先停服务）。
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
3. 命令行（服务已停止时写库）：`node tools/import-problems.mjs data/batch-01.json`
   或服务运行中走接口：`node tools/import-problems.mjs data/batch-01.json --url http://localhost:8787 --user 管理员 --pass 密码`

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
server.js                 后端（路由 / 鉴权 / 审核 / 论坛 / AI 代理 / 静态服务）
tag-taxonomy.js           主标签 / 子标签定义与历史标签归并规则
data/batch-*.json          分批题库（约 2400 道）
data/problems.seed.sample.json  示例题库（默认不加载）
data/db.json              运行时数据库（自动生成）
public/index.html         单页外壳
public/assets/style.css   全部样式
public/js/api.js          fetch 封装
public/js/md.js           Markdown + LaTeX 渲染
public/js/ui.js           头部 / Toast / 模态框 / 分页 / 评分条
public/js/app.js          路由
public/js/views/*.js      题库 / 题目 / 每日一题 / 答疑区 / 投稿 / 我的 / 审核 / AI 对话
public/vendor/katex/      本地 KaTeX（离线可用）
tools/import-problems.mjs 批量导入
tools/smoke.mjs           全链路冒烟测试（118 项断言）
tools/sync-live.mjs       部署前把线上用户数据合并回本地（凭据走环境变量）
tools/deploy.mjs          安全发布：先同步再上传（需 --publish 显式授权）
tools/migrate-tags.mjs    把历史自由标签迁移到主/子标签体系
tools/verify_integrals.py 用 sympy 对不定积分答案求导校验（多定义域点数值）
tools/verify_limits.py    极限题数值验证（mpmath 50 位精度）
tools/verify_batch5.py    第五批答案的符号校验
tools/check-katex.mjs     用仓库自带 KaTeX 校验题库公式
tools/cdp-eval.mjs        用 Edge 无头 + CDP 跑页面 JS / 截图（调试用）
```

## 测试

```bash
node tools/smoke.mjs                 # 118 项断言，覆盖注册/改密/审核/做题/AI/论坛/两级标签/权限与安全债
python tools/verify_integrals.py     # 逐题对答案求导，数值双点验证
python tools/verify_limits.py        # 极限题数值验证（高精度）
python tools/verify_batch5.py        # 第五批答案校验
node tools/check-katex.mjs           # 题库公式可渲染性检查（没有 db.json 时自动读 batch 题库）
node tools/migrate-tags.mjs          # 只报告标签迁移结果；加 --write 才写盘
```

> CI：`.github/workflows/smoke.yml` 已准备好，但当前 GitHub OAuth 只有 `repo` scope，推送工作流需要额外的 `workflow` scope；授权后再提交该文件即可。

> 录题纪律：每道积分的答案都先用 sympy 求导验证再入库，`verify_integrals.py` 里保留了对应用例，新增题目时追加即可。

## 数据同步与发布

发布一律用 `node tools/deploy.mjs`：它先把线上用户、帖子、反馈、每日记录合并回本地库，再上传，避免本地 `data/db.json` 覆盖线上数据。

脚本已移除内置的生产凭据，运行前必须显式提供：

```bash
SHARECODE=... ADMIN_PASS=... node tools/deploy.mjs --publish
# 只看差异、不写盘：
SHARECODE=... ADMIN_PASS=... node tools/sync-live.mjs --dry
```

- `SHARECODE` 或 `ADMIN_PASS` 缺失时，`tools/sync-live.mjs` 直接报错退出（退出码 2），不再回退到任何默认值。
- `tools/deploy.mjs` 默认只同步、不发布；发布必须加 `--publish`（或 `USER_ASKED_TO_PUBLISH=1`），避免误触发线上覆盖。
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
- **注意**：不要用本地 `data/db.json` 手工覆盖线上数据；发布走 `node tools/deploy.mjs`（见「数据同步与发布」）。
