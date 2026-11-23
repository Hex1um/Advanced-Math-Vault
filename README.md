# 高数好题收藏室

线上地址：**https://hex1um.github.io/math-vault/** （前端，GitHub Pages）
接口服务：https://math-vault-10141.app.workbuddy.host （后端，Node 单进程）
仓库：https://github.com/Hex1um/math-vault

一个面向高等数学的好题收藏站：**每道题都要人工审核才能进题库**，每题标注考点标签与「思维量 / 难度 / 计算量」三个 10 分制维度，全站共享同一份数据（题库、每日一题、答疑区、经验）。

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

当前题库：`data/batch-01.json` 的 20 道不定积分题，每道含分层提示、答案与分步解析，已校验入库（编号 `HS1001`–`HS1020`）。

## 账号与审核

- **第一个注册的账号自动成为管理员**（线上已有管理员 `Hex1um`）。
- 也可以在本地用脚本建/重置管理员：`node tools/create-admin.mjs <用户名> <密码>`（需先停服务）。
- 普通用户投稿 → `待审核` → 管理员在「审核后台」核对题干/解析/三维评分、可改标签与分数 → 通过后才进题库；驳回需填原因。
- 投稿通过给作者 +30 经验。
- 「我的记录 → 账号安全」可改密码；改密后其他设备会话失效。
- **做题要交答案**：写文字（LaTeX 或 `1/2` 这种）或传手写照片，AI 判对才计经验。先做规则比对（规范化相等 / 数值相等），判不了再交给模型；漏写 `+C` 判「部分正确」，不计经验但可以重交。
- 做题经验：`10 + 难度×3 + 思维量 + 计算量`；看过答案 ×0.6，问过 AI 再 ×0.8；每题只计一次。

## 批量导入题目

题目字段：

```json
{
  "title": "标题（支持 $LaTeX$）",
  "statement": "题干，行内 $...$，独立 $$...$$",
  "tags": ["极限", "泰勒展开"],
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

站点本身**不内置任何 Key**，按下面的顺序自动挑一个可用通道：

| 顺序 | 通道 | 说明 |
|---|---|---|
| 1 | 用户自带 Key | 对话里点「模型」填 OpenAI 兼容 Key，只存本机浏览器，不写数据库 |
| 2 | 站点 Key | 审核后台填写（可选，全站共用） |
| 3 | 免费公共通道 | Pollinations（`openai-fast` → `openai`）。**由浏览器直连**，用访客自己的 IP 额度，不挤在一台服务器上；同一网络 45 秒一次 |
| 4 | 本地讲解 | 内置引擎：按考点给思路骨架 + 分层提示 + 标准解答 |

界面左下角实时显示当前通道（`我的 Key` / `站点模型` / `免费通道 · 本机直连` / `本地讲解`）。
免费通道限流或超时（服务端 22 秒、浏览器直连同步降级），已输出的内容不会重复。

### 高数专家模式

对话默认开启，system prompt 固化了一套解题范式：**审题 → 定位考点 → 选策略（说明为什么不用另一条路）→ 分步执行 → 验算 → 易错点**，
并把题库里同考点题目的题干与提示作为参考资料一起喂进去（只给题干和提示，不给答案，避免照抄）。
这不是微调模型：没有算力也没有标注数据，靠的是「领域提示词 + 题库检索」把通用模型约束成高数助教。

## AI 出题

`AI 出题` 页选知识点（最多 2 个）、难度、计算量、题型，生成题干/答案/分步解析，结果可编辑后提交审核。
- 走同一套通道链；无 Key 时浏览器直连免费通道，服务端只提供提示词与结果校验（`/api/ai/prompt`、`/api/ai/parse`）。
- 生成的是**草稿**，入库仍要人工核对——实测免费模型会算错（例如把 `∫x²sech²x dx` 答成 π²/8，正确是 π²/12）。
- 限流：每小时 12 次（同一 IP）。

启动时想用固定 Key 也可以：

```bash
LLM_BASE_URL=https://api.deepseek.com/v1 LLM_MODEL=deepseek-chat LLM_API_KEY=sk-xxx node server.js
```

## 目录

```
server.js                 后端（路由 / 鉴权 / 审核 / 论坛 / AI 代理 / 静态服务）
data/batch-01.json        第一批 20 道不定积分题（已入库）
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
tools/smoke.mjs           全链路冒烟测试（46 项断言）
tools/verify_integrals.py 用 sympy 对不定积分答案求导校验（符号 + 数值）
tools/cdp-eval.mjs        用 Edge 无头 + CDP 跑页面 JS / 截图（调试用）
```

## 测试

```bash
node tools/smoke.mjs                 # 46 项断言，覆盖注册/改密/审核/做题/AI/论坛/权限
python tools/verify_integrals.py     # 逐题对答案求导，验证解析正确
```

> 录题纪律：每道积分的答案都先用 sympy 求导验证再入库，`verify_integrals.py` 里保留了对应用例，新增题目时追加即可。

## 设计说明

- **为什么不用 WebRTC**：需求是「每个用户看到的都一样」。P2P 只有在房间内有人在线时才能同步，论坛帖子和审核结果会随节点离线而丢失；改成服务端单一数据源后，任何设备、任何时间打开都是同一份内容。P2P 适合实时对战（如 BORDER OPS），不适合作为论坛的持久化真相。
- 所有响应 `Cache-Control: no-store`，静态资源引用带版本号，避免移动端缓存旧代码。
- 密码 scrypt 加盐哈希，会话为 HttpOnly Cookie（30 天）；HTTPS 下自动加 `Secure`。
- 限流：登录/注册 12 次/分、改密 6 次/分、AI 问答 40 次/10 分、投稿与发帖 20~30 次/10 分（按 IP）。
- 审核后台可「导出全部数据」（题库 + 帖子 + 每日一题记录，不含账号密码），用于重新部署前备份线上数据。
- **注意**：重新发布会用本地 `data/db.json` 覆盖线上数据，上线后的新增内容请先导出备份。
