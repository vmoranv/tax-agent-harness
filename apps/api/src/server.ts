/**
 * API 服务（无状态，可水平扩容）。
 *
 * 职责边界：
 * - **只做** HTTP 接入、参数校验、SSE 推送、静态资源
 * - **不做** 业务逻辑、不直接执行 Harness
 *
 * 执行通过两种模式：
 * - `inline`：本地开发/演示，进程内直接跑 Harness（默认）
 * - `queue`：生产，入队后由 worker 消费（需要 Redis）
 */

import { resolve } from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { log, logBroker } from '@harness/runtime';
import Fastify from 'fastify';
import { z } from 'zod';
import { loadEnv } from './env.js';
import { chatRoutes } from './routes/chat.js';
import { chatStreamRoutes } from './routes/chat-stream.js';
import { consoleRoutes } from './routes/console.js';
import { dataRoutes } from './routes/data.js';
import { demoRoutes } from './routes/demo.js';
import { evalRoutes } from './routes/eval.js';
import { integrationRoutes } from './routes/integration.js';
import { metaRoutes } from './routes/meta.js';
import { traceRoutes } from './routes/trace.js';
import { buildRuntime } from './runtime-factory.js';

// 从仓库根 .env 加载环境变量（含 HARNESS_LLM_API_KEY），必须在任何 process.env 读取之前。
loadEnv();

const ChatRequestSchema = z.object({
  text: z.string().min(1).max(4000),
  userId: z.string().regex(/^U\d{3}$/),
  enterpriseId: z.string().regex(/^C\d{3}$/),
  conversationId: z.string().optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

// 全局日志 broker 默认无订阅者；注册 stdout sink，让日志同时进服务端控制台。
// 与 Web 控制台的 SSE 订阅者共存（多订阅者互不影响），replay:false 避免重复刷历史。
logBroker.subscribe(logBroker.consoleSink(), { replay: false });

export async function createServer(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

  // 生产模式：托管 WebUI 构建产物（开发时 WebUI 走 Vite dev server + 代理）
  try {
    const { existsSync } = await import('node:fs');
    const webDist = resolve(process.cwd(), 'apps/web/dist');
    if (existsSync(webDist)) {
      await app.register(fastifyStatic, { root: webDist });
      app.setNotFoundHandler((req, reply) => {
        // SPA 回退：非 /api 路径全部回 index.html（hash 路由其实用不到，但保险）
        if (req.url.startsWith('/api')) {
          return reply.status(404).send({ error: 'NOT_FOUND' });
        }
        return reply.sendFile('index.html');
      });
    }
  } catch {
    // 静态托管失败不阻塞 API
  }

  const runtime = await buildRuntime();
  app.decorate('runtime', runtime);
  app.decorate('schemas', { ChatRequestSchema });

  await app.register(chatRoutes, { prefix: '/api' });
  await app.register(chatStreamRoutes, { prefix: '/api' });
  await app.register(traceRoutes, { prefix: '/api' });
  await app.register(metaRoutes, { prefix: '/api' });
  await app.register(consoleRoutes, { prefix: '/api' });
  await app.register(integrationRoutes, { prefix: '/api' });
  await app.register(evalRoutes, { prefix: '/api' });
  await app.register(dataRoutes, { prefix: '/api' });
  await app.register(demoRoutes, { prefix: '/api' });

  app.get('/health', async () => ({
    ok: true,
    mode: runtime.mode,
    llm: runtime.llm,
  }));

  app.addHook('onClose', async () => {
    await runtime.close();
  });

  return app;
}

/* ------------------------------ 启动 ------------------------------ */

// Windows 下 argv[1] 是反斜杠路径，`file://` 拼接比较会失效。
// 用 basename 判断更可靠；这也让 `node dist/server.js` 与 `pnpm start` 都成立。
const isMain =
  process.argv[1] !== undefined && process.argv[1].replace(/\\/g, '/').endsWith('server.js');
if (isMain) {
  const port = Number(process.env['API_PORT'] ?? 9601);
  const server = await createServer();
  try {
    await server.listen({ port, host: '0.0.0.0' });
    log.info(`API 就绪 http://localhost:${port}`);
  } catch (err) {
    log.error('API 启动失败', err);
    process.exit(1);
  }

  const shutdown = async (): Promise<void> => {
    log.info('收到停止信号，正在关闭');
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
