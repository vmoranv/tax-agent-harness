/**
 * 运行时工厂：API 与 Worker 共用。
 *
 * `mode` 决定执行方式：
 * - `inline` 进程内执行（演示 / 单机）
 * - `queue`  入队等待 worker（生产 / 多实例）
 *
 * 切换只改环境变量 `HARNESS_EXEC_MODE`，不改调用方代码。
 */

import { resolve } from 'node:path';
import { loadAll, openDatabase, type SqlDatabase, SqliteUnitOfWork } from '@harness/adapters';
import type { Deps } from '@harness/application';
import { parseMonth } from '@harness/domain';
import type { ApplicationFacade } from '@harness/runtime';
import {
  CliPlatform,
  createIds,
  createProviderBundle,
  createScriptedModel,
  Harness,
  log,
  makeMemoryLoader,
  makePreferenceLoader,
  makeRuleLoader,
  PlatformManager,
  type Script,
  type TraceSink,
} from '@harness/runtime';
import { createApplicationFacade } from './facade.js';
import { runBus } from './run-bus.js';

export type ExecMode = 'inline' | 'queue';

export interface Runtime {
  readonly mode: ExecMode;
  readonly llm: { readonly configured: boolean; readonly vendor: string; readonly model: string };
  readonly db: SqlDatabase;
  readonly deps: Deps;
  readonly facade: ApplicationFacade;
  readonly harness: Harness;
  readonly traceSink: TraceSink;
  readonly platforms: PlatformManager;
  close(): Promise<void>;
}

const REPO_ROOT = resolve(process.cwd());

export async function buildRuntime(): Promise<Runtime> {
  const dbPath = process.env['HARNESS_SQLITE_PATH'] ?? './data/runtime/harness.db';
  const db = openDatabase(dbPath);
  const uow = new SqliteUnitOfWork(db);

  // 空库时自动装载 —— 演示环境零配置可用
  const count = db.prepare('SELECT COUNT(*) AS c FROM invoice').get() as { c: number };
  if (Number(count.c) === 0) {
    log.info('数据库为空，自动装载赛题数据');
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

  const facade = createApplicationFacade(deps, db);
  const bundle = await createProviderBundle();
  if (!bundle.configured) {
    log.warn('未配置 LLM，使用脚本化模式');
  }
  const { createModel, modelId, providerId } = bundle;

  const { SqliteTraceSink, createSessionAdapter } = await import('@harness/adapters');
  const traceSink = new SqliteTraceSink(db);
  // 多实例部署时禁用：无实例归属信息，「清空未完成 run」会把其他存活实例
  // 正在执行的 run 误标为中断。崩溃恢复交由 Redis 波次的实例心跳机制处理。
  if (process.env['HARNESS_MULTI_INSTANCE'] !== '1') {
    await traceSink.markInterrupted();
  }

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
    // 演示模式：前端可在事件上挂剧本，本轮改用脚本化模型，
    // 但**仍然走完整 Harness**（trace / 会话 / 任务卡 / 溯源全部生效）。
    modelFor: (event) => {
      const script = event.getExtra<Script>('script');
      return script === undefined ? null : createScriptedModel(script);
    },
    maxSteps: Number(process.env['HARNESS_LLM_MAX_STEPS'] ?? 8),
    onEvent: (e) => runBus.publish(e),
  });

  const platforms = new PlatformManager();
  platforms.register(new CliPlatform('api', () => undefined));

  return {
    mode: (process.env['HARNESS_EXEC_MODE'] as ExecMode) ?? 'inline',
    llm: { configured: bundle.configured, vendor: providerId, model: modelId },
    db,
    deps,
    facade,
    harness,
    traceSink,
    platforms,
    close: async (): Promise<void> => {
      db.close();
    },
  };
}

export { parseMonth };
