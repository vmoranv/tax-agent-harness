/** 运行记录查询。 */
import type { FastifyInstance } from 'fastify';
import type { Runtime } from '../runtime-factory.js';

/** 运行记录列表默认返回条数。 */
const DEFAULT_TRACE_LIMIT = 20;

/** 从 Fastify 实例取挂载的 Runtime（统一收敛重复强转）。 */
const runtimeOf = (app: FastifyInstance): Runtime =>
  (app as unknown as { runtime: Runtime }).runtime;

export async function traceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/trace', async (req) => {
    const runtime = runtimeOf(app);
    const limit = Number((req.query as { limit?: string }).limit ?? DEFAULT_TRACE_LIMIT);
    const rows = runtime.db
      .prepare(
        'SELECT run_id, started_at, final_preview, has_error FROM trace_run ORDER BY started_at DESC LIMIT ?',
      )
      .all(limit) as Array<Record<string, unknown>>;
    return { runs: rows };
  });

  app.get('/trace/:runId', async (req, reply) => {
    const runtime = runtimeOf(app);
    const { runId } = req.params as { runId: string };
    const run = await runtime.traceSink.get(runId);
    if (run === null) return reply.status(404).send({ error: 'NOT_FOUND' });
    return run;
  });
}
