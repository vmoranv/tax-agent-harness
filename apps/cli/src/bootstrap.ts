/**
 * 装配根。
 *
 * 职责收窄（工业级重构）：原来混了配置读取、种子装载、ID 生成、装配。
 * 现在只做装配：
 * - 配置 → `config.ts`
 * - 依赖容器 → `container.ts`
 * - 种子数据 → `seed-data.ts`
 */

import { resolve } from 'node:path';
import { parseMonth } from '@harness/domain';
import {
  CliPlatform,
  createProviderBundle,
  Harness,
  log,
  logBroker,
  makeMemoryLoader,
  makePreferenceLoader,
  makeRuleLoader,
  PlatformManager,
  type ProviderConfig,
  type ProviderManager,
} from '@harness/runtime';
import { type AppConfig, loadConfig } from './config.js';
import { type Container, createSqliteContainer } from './container.js';
import { createFacade } from './facade.js';
import { seedFromXlsx } from './seed-data.js';

export interface BootstrapOptions {
  readonly config?: AppConfig;
  readonly seed?: boolean;
  readonly datasetPath?: string;
  readonly rulesPath?: string;
  readonly verbose?: boolean;
}

export interface App {
  readonly config: AppConfig;
  readonly container: Container;
  readonly harness: Harness;
  readonly platforms: PlatformManager;
  readonly providers: ProviderManager;
  readonly facade: ReturnType<typeof createFacade>;
  close(): Promise<void>;
}

const REPO_ROOT = resolve(process.cwd());

export async function bootstrap(opts: BootstrapOptions = {}): Promise<App> {
  const config = opts.config ?? loadConfig();

  if (opts.verbose === true || config.logLevel === 'debug') {
    logBroker.subscribe(logBroker.consoleSink());
  }

  const container = createSqliteContainer(config.sqlitePath);

  if (opts.seed === true) {
    await seedFromXlsx(container.db, {
      xlsx: opts.datasetPath ?? resolve(REPO_ROOT, 'fixtures/excel/02_示例数据.xlsx'),
      rules: opts.rulesPath ?? resolve(REPO_ROOT, 'fixtures/rules.seed.json'),
    });
  }

  const facade = createFacade(container.deps, container.db);
  const cfg: ProviderConfig = {
    id: 'default',
    type: 'openai-compatible',
    baseUrl: config.llm.baseUrl,
    apiKey: config.llm.apiKey,
    model: config.llm.model,
  };
  const providers = await createProviderBundle(cfg);
  if (!providers.configured) {
    log.warn('未配置 LLM 端点，模型不可用；可用 --script 演示');
  }

  const { SqliteTraceSink, createSessionAdapter } = await import('@harness/adapters');
  const traceSink = new SqliteTraceSink(container.db);

  const harness = new Harness({
    app: facade,
    traceSink,
    createModel: providers.createModel,
    modelId: providers.modelId,
    providerId: providers.providerId,
    loadRules: makeRuleLoader(container.uow),
    loadMemory: makeMemoryLoader(container.uow),
    loadPreferences: makePreferenceLoader(container.uow),
    session: createSessionAdapter(container.uow),
    maxSteps: config.llm.maxSteps,
    budgetTokens: config.budgetTokens,
  });

  const platforms = new PlatformManager();
  platforms.register(new CliPlatform());

  return {
    config,
    container,
    harness,
    platforms,
    providers: providers.manager,
    facade,
    close: container.close,
  };
}

export { parseMonth };
