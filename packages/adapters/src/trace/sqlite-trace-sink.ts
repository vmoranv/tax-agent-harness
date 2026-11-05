/**
 * 运行记录 SQLite → TraceSink 适配层。
 *
 * 放在 adapters（而非 runtime）是有意的：runtime 只定义 `TraceSink` 端口，
 * 具体存储实现属于基础设施。这样 runtime 不依赖 `node:sqlite`，
 * 换 PG 时只需换这个文件。
 */

import type { TraceRunSnapshot, TraceSink } from '@harness/runtime';

/** 只用到极少 SQL 面，不依赖具体驱动实现。 */
interface SyncSqlDatabase {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

const MAX_TEXT = 20_000;

function clip(s: string, max = MAX_TEXT): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[已截断 ${s.length - max} 字]`;
}

/**
 * SQLite 版 sink。内部同步执行（`node:sqlite` 无异步驱动），对外暴露 Promise。
 */
export class SqliteTraceSink implements TraceSink {
  constructor(
    private readonly db: SyncSqlDatabase,
    private readonly maxRuns = 500,
  ) {}

  async save(run: TraceRunSnapshot): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO trace_run
           (run_id, session_id, user_id, enterprise_id, started_at, finished_at,
            elapsed_ms, payload, final_preview, has_error)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (run_id) DO UPDATE SET
           finished_at = excluded.finished_at,
           elapsed_ms = excluded.elapsed_ms,
           payload = excluded.payload,
           final_preview = excluded.final_preview,
           has_error = excluded.has_error`,
      )
      .run(
        run.runId,
        run.sessionId,
        run.userId,
        run.enterpriseId,
        run.startedAt,
        run.finishedAt,
        run.elapsedMs,
        JSON.stringify(run),
        clip(run.finalText, 200),
        run.error === null ? 0 : 1,
      );

    this.prune();
  }

  async get(runId: string): Promise<TraceRunSnapshot | null> {
    const r = this.db.prepare('SELECT payload FROM trace_run WHERE run_id = ?').get(runId) as
      | { payload: string }
      | undefined;
    return r === undefined ? null : (JSON.parse(r.payload) as TraceRunSnapshot);
  }

  async list(
    limit = 20,
    filter: { readonly userId?: string; readonly enterpriseId?: string } = {},
  ): Promise<TraceRunSnapshot[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.userId !== undefined) {
      clauses.push('user_id = ?');
      params.push(filter.userId);
    }
    if (filter.enterpriseId !== undefined) {
      clauses.push('enterprise_id = ?');
      params.push(filter.enterpriseId);
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const rows = this.db
      .prepare(`SELECT payload FROM trace_run ${where} ORDER BY started_at DESC LIMIT ?`)
      .all(...params, limit) as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as TraceRunSnapshot);
  }

  async markInterrupted(): Promise<number> {
    const r = this.db
      .prepare(
        `UPDATE trace_run
            SET has_error = 1, finished_at = COALESCE(finished_at, started_at)
          WHERE finished_at IS NULL`,
      )
      .run();
    return r.changes;
  }

  private prune(): void {
    this.db
      .prepare(
        `DELETE FROM trace_run WHERE run_id IN (
           SELECT run_id FROM trace_run ORDER BY started_at DESC LIMIT -1 OFFSET ?)`,
      )
      .run(this.maxRuns);
  }
}
