/**
 * 环境变量加载（API 进程）。
 *
 * 背景：改造前 apps/api 不加载 dotenv，直接读 process.env，
 * 导致用户写在仓库根 .env 里的 HARNESS_LLM_* 对 API 进程无效。
 * 本模块统一负责「找到仓库根 .env 并加载」，供服务入口在读取任何
 * process.env 之前调用一次 loadEnv()。
 *
 * 安全约束：apiKey 只允许留在 process.env / llmConfig() 返回值中，
 * 绝不写入日志或 HTTP 响应；对外只回显 configured 布尔，不回显密钥。
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

/** 仓库根锚点：pnpm-workspace.yaml 只存在于仓库根，不会与 apps/* 子包混淆。 */
const REPO_MARKER = 'pnpm-workspace.yaml';

/** 默认值，与 .env.example / 既有 providerConfigFromEnv 保持一致。 */
const DEFAULT_MAX_STEPS = 8;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MODEL = 'gpt-4o-mini';

/** LLM 配置汇总。apiKey 为敏感字段，仅限进程内使用，禁止对外输出。 */
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

/**
 * 加载仓库根 .env 到 process.env。幂等：多次调用只加载一次。
 * - 已存在的进程环境变量优先（dotenv 默认不覆盖），便于 CI / 容器注入覆盖 .env。
 * - quiet:true 抑制 dotenv 自身日志，避免任何环境变量内容外泄。
 * - .env 缺失是允许的（纯环境变量部署场景），不抛错。
 */
export function loadEnv(): void {
  if (loaded) {
    return;
  }
  loaded = true;
  dotenvConfig({ path: resolve(findRepoRoot(), '.env'), quiet: true });
}

/** 读取环境变量，缺失时返回默认值（默认空串）。 */
export function getEnv(key: string, defaultValue = ''): string {
  return process.env[key] ?? defaultValue;
}

/**
 * 汇总 LLM 配置。configured 以「baseUrl 与 apiKey 均非空」为准，
 * 与 runtime 的 providerConfigFromEnv / hasLlm 判定保持一致。
 * 注意：返回值含明文 apiKey，仅限进程内使用，严禁写日志或 HTTP 响应。
 */
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
