/**
 * 数据中台端点：库表概览与白名单表的分页浏览。
 *
 * 安全：SQL 里的表名只取自模块内白名单常量（而非 URL 参数原文），杜绝注入。
 */
import type { FastifyInstance } from 'fastify';
import type { Runtime } from '../runtime-factory.js';

/** 允许浏览的表（与 packages/adapters/src/sqlite/schema.ts 对齐）。 */
const TABLES: ReadonlyArray<{ name: string; label: string }> = [
  { name: 'invoice', label: '发票台账' },
  { name: 'bank_txn', label: '银行流水' },
  { name: 'rule_doc', label: '规则库' },
  { name: 'task_card', label: '任务卡' },
  { name: 'preference', label: '用户偏好' },
  { name: 'session', label: '会话' },
  { name: 'message', label: '消息' },
  { name: 'trace_run', label: '运行记录' },
  { name: 'app_user', label: '用户' },
  { name: 'enterprise', label: '企业' },
  { name: 'grant', label: '授权' },
];

/** 分页每页最大条数（防止一次拉全表）。 */
const MAX_LIMIT = 200;
/** 分页每页默认条数。 */
const DEFAULT_LIMIT = 50;
/** trace_run.payload 截断长度（字符数），避免大响应。 */
const TRACE_PAYLOAD_MAX = 120;
/** 分页 limit 下限（至少取 1 行）。 */
const MIN_LIMIT = 1;

/** 从 Fastify 实例取挂载的 Runtime（统一收敛重复强转）。 */
const runtimeOf = (app: FastifyInstance): Runtime =>
  (app as unknown as { runtime: Runtime }).runtime;

type TableQuery = { limit?: string; offset?: string };

function clampInt(value: unknown, def: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 统计表行数；name 已由白名单规范化。 */
function countOf(rt: Runtime, name: string): number {
  const row = rt.db.prepare(`SELECT COUNT(*) AS cnt FROM "${name}"`).get();
  return Number(row?.['cnt'] ?? 0);
}

/** trace_run.payload 可能很大，截断避免大响应。 */
function truncatePayload(row: Record<string, unknown>): Record<string, unknown> {
  const payload = row['payload'];
  if (typeof payload === 'string' && payload.length > TRACE_PAYLOAD_MAX) {
    return { ...row, payload: payload.slice(0, TRACE_PAYLOAD_MAX) + '…' };
  }
  return row;
}

export async function dataRoutes(app: FastifyInstance): Promise<void> {
  // 1. 概览：各表 COUNT
  app.get('/data/overview', async () => {
    const runtime = runtimeOf(app);
    const tables = TABLES.map((t) => ({
      name: t.name,
      label: t.label,
      count: countOf(runtime, t.name),
    }));
    const totals: Record<string, number> = {};
    for (const t of tables) totals[t.name] = t.count;
    return { tables, totals, generatedAt: new Date().toISOString() };
  });

  // 2. 单表分页
  app.get('/data/table/:name', async (req, reply) => {
    const params = req.params as { name: string };
    const entry = TABLES.find((t) => t.name === params.name);
    if (entry === undefined) {
      return reply.status(400).send({
        error: 'INVALID_TABLE',
        message: `表名不在白名单内: ${params.name}`,
      });
    }
    // 用白名单的规范名拼 SQL，绝不直接使用 URL 参数原文。
    const name = entry.name;
    const q = req.query as TableQuery;
    const limit = clampInt(q.limit, DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
    const offset = clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    const runtime = runtimeOf(app);
    const total = countOf(runtime, name);
    const rawRows = runtime.db
      .prepare(`SELECT * FROM "${name}" LIMIT ? OFFSET ?`)
      .all(limit, offset);

    // 优先用真实行推导列；空结果（或偏移越界）时回退到 PRAGMA。
    let columns = rawRows.length > 0 ? Object.keys(rawRows[0] ?? {}) : [];
    if (columns.length === 0) {
      columns = runtime.db
        .prepare(`PRAGMA table_info("${name}")`)
        .all()
        .map((r) => String(r['name']));
    }

    const rows = name === 'trace_run' ? rawRows.map(truncatePayload) : rawRows;
    return { name, columns, rows, total };
  });
}
