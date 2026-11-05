## 改动

<!-- 说清改了什么、为什么；一次 PR 一个主题 -->

## 验证

<!-- 本地实测，不要只写"应该没问题" -->

- [ ] `pnpm build`
- [ ] `pnpm verify`（typecheck / lint / dep:check / test / build:test / eval:cov / eval）
- [ ] 涉及真模型或评测集时：`pnpm eval:semantic:live` / `pnpm eval:heldout` 已实跑并如实记录分数

## 诚实边界

<!-- 有没有没做的、不能外推的、非确定性/需 apikey 的部分；不要把"满分/全绿"写成能力达标 -->

## 提交卫生

- [ ] commit message 用 `type(scope):` 前缀，无明显噪音
- [ ] 未提交 `.env` / `*.db` / `dist` / 临时产物 / `docs/`（已 gitignore）
