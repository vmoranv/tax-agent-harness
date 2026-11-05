/**
 * 环境变量加载（CLI 进程）。
 *
 * 与 apps/api / apps/worker 的 env.ts 同模式：入口在读取任何 process.env
 * 之前调用一次 loadEnv()，把仓库根 .env 加载进进程环境。
 * apps/cli 本来就声明了 dotenv 依赖，这里补上实际加载。
 *
 * 安全：apiKey 等密钥只在 process.env 内流转，绝不打印明文。
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

const REPO_MARKER = 'pnpm-workspace.yaml';

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MODEL = 'gpt-4o-mini';

export interface LlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly configured: boolean;
}

let loaded = false;

/** 从 process.cwd() 向上找 pnpm-workspace.yaml 所在目录；找不到则退回 process.cwd()。 */
function findRepoRoot(): string {
  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(resolve(dir, REPO_MARKER))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return resolve(process.cwd());
    }
    dir = parent;
  }
}

/** 幂等加载仓库根 .env；已存在的进程环境变量优先（不覆盖）。 */
export function loadEnv(): void {
  if (loaded) {
    return;
  }
  loaded = true;
  dotenvConfig({ path: resolve(findRepoRoot(), '.env'), quiet: true });
}

export function getEnv(key: string, defaultValue = ''): string {
  return process.env[key] ?? defaultValue;
}

export function llmConfig(): LlmConfig {
  const baseUrl = getEnv('HARNESS_LLM_BASE_URL');
  const apiKey = getEnv('HARNESS_LLM_API_KEY');
  const model = getEnv('HARNESS_LLM_MODEL', DEFAULT_MODEL);
  const maxSteps = Number(getEnv('HARNESS_LLM_MAX_STEPS', String(DEFAULT_MAX_STEPS)));
  const timeoutMs = Number(getEnv('HARNESS_LLM_TIMEOUT_MS', String(DEFAULT_TIMEOUT_MS)));
  return {
    baseUrl,
    apiKey,
    model,
    maxSteps: Number.isFinite(maxSteps) ? maxSteps : DEFAULT_MAX_STEPS,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
    configured: baseUrl !== '' && apiKey !== '',
  };
}
