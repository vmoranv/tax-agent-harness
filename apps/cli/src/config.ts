/**
 * 配置解析与校验。
 *
 * 从 bootstrap 拆出：环境变量读取是「策略」，不该和「装配」混在一起。
 * 用 zod 校验，缺关键项时启动期就报错，而不是运行到一半才炸。
 */

import { z } from 'zod';

const DriverEnum = z.enum(['pg', 'sqlite']);

const ConfigSchema = z.object({
  dbDriver: DriverEnum.default('sqlite'),
  databaseUrl: z.string().optional(),
  sqlitePath: z.string().default('./data/runtime/harness.db'),
  redisUrl: z.string().optional(),
  llm: z.object({
    baseUrl: z.string().default(''),
    apiKey: z.string().default(''),
    model: z.string().default('gpt-4o-mini'),
    maxSteps: z.coerce.number().int().min(1).max(20).default(8),
    timeoutMs: z.coerce.number().int().min(1000).default(90_000),
  }),
  budgetTokens: z.coerce.number().int().min(1000).default(12_000),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  apiPort: z.coerce.number().int().default(9601),
  workerConcurrency: z.coerce.number().int().min(1).default(4),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse({
    dbDriver: env['HARNESS_DB_DRIVER'],
    databaseUrl: env['DATABASE_URL'],
    sqlitePath: env['HARNESS_SQLITE_PATH'],
    redisUrl: env['REDIS_URL'],
    llm: {
      baseUrl: env['HARNESS_LLM_BASE_URL'],
      apiKey: env['HARNESS_LLM_API_KEY'],
      model: env['HARNESS_LLM_MODEL'],
      maxSteps: env['HARNESS_LLM_MAX_STEPS'],
      timeoutMs: env['HARNESS_LLM_TIMEOUT_MS'],
    },
    budgetTokens: env['HARNESS_BUDGET_TOKENS'],
    logLevel: env['LOG_LEVEL'],
    apiPort: env['API_PORT'],
    workerConcurrency: env['WORKER_CONCURRENCY'],
  });

  if (!parsed.success) {
    throw new Error(
      `配置校验失败：${parsed.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ')}`,
    );
  }

  const cfg = parsed.data;

  // 跨字段校验：选了 pg 就必须有连接串
  if (cfg.dbDriver === 'pg' && (cfg.databaseUrl === undefined || cfg.databaseUrl === '')) {
    throw new Error('HARNESS_DB_DRIVER=pg 时必须提供 DATABASE_URL');
  }

  return cfg;
}

/** 模型是否可用（未配置时用脚本化演示）。 */
export function isLlmConfigured(cfg: AppConfig): boolean {
  return cfg.llm.baseUrl !== '' && cfg.llm.apiKey !== '';
}
