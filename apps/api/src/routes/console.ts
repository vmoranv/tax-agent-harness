/**
 * 实时日志控制台端点。
 *
 * 数据源是 runtime 的全局 `logBroker`（环形缓存 + 多订阅者），
 * 与 CLI / Harness 共用同一条日志管道，不另起一套。
 *
 * - GET /api/console/logs/recent  首次加载拉取最近 N 条
 * - GET /api/console/logs/stream  SSE 实时推送（含重放）
 */

import { type LogEntry, logBroker } from '@harness/runtime';
import type { FastifyInstance } from 'fastify';

/** recent 接口允许返回的最大日志条数。 */
const MAX_RECENT = 500;
/** recent 接口未传 limit 时的默认条数、以及最少返回条数。 */
const DEFAULT_RECENT = 200;
const MIN_RECENT = 1;
/** SSE keep-alive 心跳间隔（毫秒），防止中间代理掐断空闲连接。 */
const SSE_HEARTBEAT_MS = 15_000;

/** 日志里的密钥在 LogBroker.emit 已脱敏，这里只做结构序列化。 */
function serialize(e: LogEntry): Record<string, unknown> {
  return {
    level: e.level,
    time: e.time,
    msg: e.msg,
    context: e.context,
    ...(e.fields === undefined ? {} : { fields: e.fields }),
    ...(e.error === undefined ? {} : { error: e.error }),
  };
}

function recentLimit(raw: unknown): number {
  const parsed =
    typeof raw === 'object' && raw !== null && 'limit' in raw ? Number(raw.limit) : Number.NaN;
  return Math.min(
    MAX_RECENT,
    Math.max(MIN_RECENT, Number.isFinite(parsed) ? parsed : DEFAULT_RECENT),
  );
}

export async function consoleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/console/logs/recent', async (req) => {
    return { logs: logBroker.recent(recentLimit(req.query)).map(serialize) };
  });

  app.get('/console/logs/stream', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const write = (e: LogEntry): void => {
      reply.raw.write(`event: log\ndata: ${JSON.stringify(serialize(e))}\n\n`);
    };

    // subscribe 默认回放缓存，前端能立刻看到历史日志。
    const unsubscribe = logBroker.subscribe(write);

    // SSE keep-alive 心跳，防止中间代理把空闲连接掐断。
    const heartbeat = setInterval(() => {
      reply.raw.write(': keep-alive\n\n');
    }, SSE_HEARTBEAT_MS);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
