# 财税 Agent Harness WebUI

基于 Vue 3 + Vuetify 3 + Pinia 构建的工业级可视化工作台。

## 本地开发

先在项目根目录启动 API 服务：

```bash
pnpm --filter @harness/api start
# 运行在 http://localhost:9601
```

在前端目录启动 Web 调试服务器：

```bash
cd apps/web
pnpm dev
# 默认端口 http://localhost:9601，自动代理 /api 至 http://localhost:9601
```

## 生产构建

```bash
cd apps/web
pnpm build
```

产物输出至 `dist/`，由 `@harness/api` 直接托管静态资源。
