## 这个 PR 做了什么

<!-- 一到三句话，说明动机与结果；「修了什么 bug」要写清修复前的症状 -->

## 影响范围

- [ ] 后端接口（routes/ / lib/）
- [ ] 前端页面（public/）
- [ ] 题库数据（data/batch-*.json）
- [ ] 工具与 CI（tools/ / .github/）
- [ ] 仅文档

## 自检

- [ ] `npm test`（JSON 引擎）通过
- [ ] `npm run test:sqlite`（SQLite 引擎）通过
- [ ] `npm run check:delims` 无新增未闭合分隔符
- [ ] `npm run check:equiv` 通过（如果改了判题逻辑）
- [ ] 没有提交 `data/db.json`、备份文件或任何密钥
- [ ] 前端资源 `?v=` 版本串已同步升级

## 备注

<!-- 数据结构变更、迁移、回滚方式，以及需要 reviewer 特别看的地方 -->
