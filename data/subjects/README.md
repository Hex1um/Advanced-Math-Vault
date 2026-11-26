# 科目突击包（已下线）

`v3.5.0` 起本科目包内容暂时下线：本目录不再包含任何 `*.json` 包，`/api/sprint/packs` 返回空列表，
`/api/meta` 的 `features.sprint` 与 `features.vocab` 均为 `false`，前端导航自动隐藏「期末突击」入口。

## 为什么保留这个目录与代码

- `lib/sprint.js`、`routes/sprint.js`、`public/js/views/sprint*.js` 全部保留，只是没有数据可加载。
- 特性开关改成按包数动态判断（`packs.length > 0`），不是硬编码关闭。

## 恢复方法

1. 把包文件放回本目录（原先的 11 个包：`hust-*`、`cet4/cet6`、`physics-general-2026`、
   `bnu-mechanics/astro-intro/physics-lab-2026`，以及 `vocab/` 词库目录）；
2. 重启服务。`features.sprint` 会自动变回 `true`，导航与突击页恢复，无需改代码；
3. `npm run check:sprint`（科目包体检）会从「跳过」恢复为完整校验。

数据已在本机归档到 `_archive/subjects/`（工作区根，不入仓库）。
