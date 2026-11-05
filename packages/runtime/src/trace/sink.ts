/**
 * 运行记录落盘端口（TraceSink）。
 *
 * 抽成异步接口的目的：让 Harness 不再绑定 `node:sqlite` 的同步 `prepare`。
 * - SQLite 实现：`SqliteTraceStore`，内部同步调用，对外仍是 Promise
 * - PostgreSQL 实现：`PgTraceSink`（见 `packages/adapters`），走 drizzle 异步
 *
 * Harness 只认这个接口，所以「换库」不需要改运行时。
 */

import type { TraceRunSnapshot } from './index.js';

export interface TraceSink {
  save(run: TraceRunSnapshot): Promise<void>;
  get(runId: string): Promise<TraceRunSnapshot | null>;
  list(
    limit?: number,
    filter?: { readonly userId?: string; readonly enterpriseId?: string },
  ): Promise<TraceRunSnapshot[]>;
  /** 启动时把上次崩溃留下未完成的 run 标记为中断，返回条数。 */
  markInterrupted(): Promise<number>;
}

/** 只写不读的轻量 sink（测试 / 内存），便于单测替换。 */
export class MemoryTraceSink implements TraceSink {
  private readonly runs = new Map<string, TraceRunSnapshot>();

  async save(run: TraceRunSnapshot): Promise<void> {
    this.runs.set(run.runId, run);
  }

  async get(runId: string): Promise<TraceRunSnapshot | null> {
    return this.runs.get(runId) ?? null;
  }

  async list(
    limit = 20,
    filter: { readonly userId?: string; readonly enterpriseId?: string } = {},
  ): Promise<TraceRunSnapshot[]> {
    return [...this.runs.values()]
      .filter((r) => (filter.userId === undefined ? true : r.userId === filter.userId))
      .filter((r) =>
        filter.enterpriseId === undefined ? true : r.enterpriseId === filter.enterpriseId,
      )
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
      .slice(0, limit);
  }

  async markInterrupted(): Promise<number> {
    let n = 0;
    for (const [id, run] of this.runs) {
      if (run.finishedAt === null) {
        this.runs.set(id, {
          ...run,
          error: { code: 'INTERRUPTED', message: '进程中断，本轮未完成' },
        });
        n += 1;
      }
    }
    return n;
  }
}
