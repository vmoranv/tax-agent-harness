/**
 * SSE 流式对话（EventSource 兼容，GET + 查询参数）。
 *
 * 事件序列：
 *   event: run.started   data: {"runId":"..."}
 *   event: tool          data: {"name":"...","ok":true}
 *   event: done          data: {"runId":"...","text":"..."}
 *   event: error         data: {"message":"..."}
 *
 * 单实例：进程内 runBus 直连；多实例时把 runBus 换 Redis Pub/Sub。
 */

import { enterpriseId, userId } from '@harness/domain';
import { MessageEvent, Umo } from '@harness/runtime';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runBus } from '../run-bus.js';
import type { Runtime } from '../runtime-factory.js';

/** 对话文本最大长度（字符数）。 */
const MAX_TEXT_LENGTH = 4000;
/** runId 随机后缀：从 Math.random().toString(36) 截取的起止位置。 */
const RUN_ID_SUFFIX_START = 2;
const RUN_ID_SUFFIX_END = 6;

/** 请求体校验失败时统一的 400 响应体。 */
function validationError(error: z.core.$ZodError): { error: string; details: string[] } {
  return {
    error: 'VALIDATION_FAILED',
    details: error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`),
  };
}

/** 从 Fastify 实例取挂载的 Runtime（统一收敛重复强转）。 */
const runtimeOf = (app: FastifyInstance): Runtime =>
  (app as unknown as { runtime: Runtime }).runtime;

const QuerySchema = z.object({
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  userId: z.string().regex(/^U\d{3}$/),
  enterpriseId: z.string().regex(/^C\d{3}$/),
});

export async function chatStreamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/chat/stream', async (req, reply) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send(validationError(parsed.error));
    }

    const runtime = runtimeOf(app);
    const { text, userId: uid, enterpriseId: eid } = parsed.data;
    const runId = `run_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(RUN_ID_SUFFIX_START, RUN_ID_SUFFIX_END)}`;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`event: run.started\ndata: ${JSON.stringify({ runId })}\n\n`);

    const unsubscribe = runBus.subscribe(runId, (e) => {
      switch (e.type) {
        case 'tool':
          reply.raw.write(`event: tool\ndata: ${JSON.stringify({ name: e.name, ok: e.ok })}\n\n`);
          break;
        case 'done':
          reply.raw.write(
            `event: done\ndata: ${JSON.stringify({ runId: e.runId, text: e.text })}\n\n`,
          );
          reply.raw.end();
          break;
        case 'error':
          reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
          reply.raw.end();
          break;
      }
    });

    req.raw.on('close', () => unsubscribe());

    const event = new MessageEvent(Umo.of('api', 'http', `${uid}-${eid}`), {
      userId: userId(uid),
      enterpriseId: enterpriseId(eid),
      text,
      messageId: runId,
      receivedAt: new Date().toISOString(),
    });
    event.setExtra('enterpriseName', eid);
    event.setExtra('accessLevel', 'read-write');

    // 不 await：SSE 流式返回期间执行
    void runtime.harness.handle(event, runtime.platforms.get('api'), { runId });
  });
}
