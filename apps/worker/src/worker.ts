/**
 * Worker 服务（无状态，可水平扩容）。
 *
 * 当前实现是**进程内队列**（开发/演示）。生产模式应接 BullMQ：
 * 只需把 `consume()` 换成 `new Worker('run', handler)`，其余不变 ——
 * 这是把队列抽象成接口的收益。
 *
 * 三件必须做的事：
 * 1. 启动时标记上次中断的 run
 * 2. 每个任务加分布式锁（防同一 run 被两个实例消费）
 * 3. 优雅停机（等在跑的任务结束）
 */

import { resolve } from 'node:path';
import { loadAll, openDatabase, type SqlDatabase, SqliteUnitOfWork } from '@harness/adapters';
import type { Deps } from '@harness/application';
import { parseMonth } from '@harness/domain';
import {
  CliPlatform,
  createIds,
  createProviderBundle,
  Harness,
  log,
  MessageEvent,
  makeMemoryLoader,
  makePreferenceLoader,
  makeRuleLoader,
  PlatformManager,
  Umo,
} from '@harness/runtime';
import { loadEnv } from './env.js';

// 加载仓库根 .env（含 HARNESS_LLM_API_KEY），须在任何 process.env 读取之前。
loadEnv();

export interface RunJob {
  readonly runId: string;
  readonly userId: string;
  readonly enterpriseId: string;
  readonly text: string;
}

const REPO_ROOT = resolve(process.cwd());

export class Worker {
  private draining = false;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly db: SqlDatabase,
    private readonly harness: Harness,
    private readonly platforms: PlatformManager,
  ) {}

  /** 启动时的清理：上次进程崩溃留下的未完成 run。 */
  markInterrupted(): void {
    const r = this.db
      .prepare(
        `UPDATE trace_run
            SET has_error = 1,
                finished_at = COALESCE(finished_at, started_at)
          WHERE finished_at IS NULL`,
      )
      .run();
    if (r.changes > 0) log.warn(`标记 ${r.changes} 条中断的 run`);
  }

  async consume(job: RunJob): Promise<void> {
    if (this.draining) {
      log.warn('worker 正在停机，拒绝新任务', { runId: job.runId });
      return;
    }

    const task = this.execute(job).finally(() => this.inFlight.delete(task));
    this.inFlight.add(task);
    await task;
  }

  private async execute(job: RunJob): Promise<void> {
    const event = new MessageEvent(Umo.of('worker', 'queue', job.runId), {
      userId: job.userId as never,
      enterpriseId: job.enterpriseId as never,
      text: job.text,
      messageId: job.runId,
      receivedAt: new Date().toISOString(),
    });
    event.setExtra('enterpriseName', job.enterpriseId);

    try {
      const r = await this.harness.handle(event, this.platforms.get('worker'));
      log.info('任务完成', { runId: r.runId, toolCalls: r.toolCallCount });
    } catch (err) {
      log.error('任务失败', err, { runId: job.runId });
    }
  }

  /** 优雅停机：等在跑的任务结束，最多等 30 秒。 */
  async shutdown(): Promise<void> {
    this.draining = true;
    if (this.inFlight.size === 0) return;

    log.info(`等待 ${this.inFlight.size} 个任务结束`);
    // 显式持有 timer：任务提前结束时清理，避免 30s 兜底计时器滞留事件循环、
    // 拖慢进程退出（执行器不返回 timer，同时消除 noPromiseExecutorReturn）。
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise<void>((r) => {
          timer = setTimeout(r, 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  get pending(): number {
    return this.inFlight.size;
  }
}

/* ------------------------------ 启动 ------------------------------ */

export async function buildWorker(): Promise<{ worker: Worker; close: () => Promise<void> }> {
  const dbPath = process.env['HARNESS_SQLITE_PATH'] ?? './data/runtime/harness.db';
  const db = openDatabase(dbPath);
  const uow = new SqliteUnitOfWork(db);

  const count = db.prepare('SELECT COUNT(*) AS c FROM invoice').get() as { c: number };
  if (Number(count.c) === 0) {
    await loadAll(
      db,
      resolve(REPO_ROOT, 'fixtures/excel/02_示例数据.xlsx'),
      resolve(REPO_ROOT, 'fixtures/rules.seed.json'),
    );
  }

  const deps: Deps = {
    uow,
    clock: {
      now: (): Date => new Date(),
      today: () => new Date().toISOString().slice(0, 10) as never,
    },
    ids: createIds(),
  };

  const { createApplicationFacade } = await import('./facade.js');
  const facade = createApplicationFacade(deps, db);

  const bundle = await createProviderBundle();
  const { createModel, modelId, providerId } = bundle;

  const { SqliteTraceSink, createSessionAdapter } = await import('@harness/adapters');
  const traceSink = new SqliteTraceSink(db);

  const harness = new Harness({
    app: facade,
    traceSink,
    createModel,
    modelId,
    providerId,
    loadRules: makeRuleLoader(uow),
    loadMemory: makeMemoryLoader(uow),
    loadPreferences: makePreferenceLoader(uow),
    session: createSessionAdapter(uow),
    maxSteps: Number(process.env['HARNESS_LLM_MAX_STEPS'] ?? 8),
  });

  const platforms = new PlatformManager();
  platforms.register(new CliPlatform('worker', () => undefined));

  const worker = new Worker(db, harness, platforms);
  // 多实例部署时禁用：会误标其他存活实例正在执行的 run（与 API 同一约定）。
  if (process.env['HARNESS_MULTI_INSTANCE'] !== '1') {
    worker.markInterrupted();
  }

  return {
    worker,
    close: async (): Promise<void> => {
      await worker.shutdown();
      db.close();
    },
  };
}

export { parseMonth };
