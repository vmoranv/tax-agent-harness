/**
 * Provider 管理器：从「一行配置」到「可用的 LanguageModel」。
 *
 * 三级解析（
 *   显式 vendor → 环境变量 → 默认（openai-chat）
 *
 * 与之前版本的区别：不再硬编码 openai-compatible，
 * 而是按厂商预设自动选择四套协议之一。
 */

import type { LanguageModel } from 'ai';
import { createAdapter } from './adapters.js';
import {
  getPreset,
  listVendors,
  type ProtocolAdapter,
  type ProtocolConfig,
  type ProtocolId,
} from './protocol.js';

/** 未显式指定协议、且厂商预设无协议时使用的兜底协议。 */
const DEFAULT_PROTOCOL: ProtocolId = 'openai-chat';
/** 未指定厂商时（含环境变量解析）的兜底厂商标识。 */
const DEFAULT_VENDOR_ID = 'custom';

export interface ResolveOptions {
  /** 厂商标识，如 `deepseek` / `anthropic` / `zhipu`。 */
  readonly vendor?: string;
  /** 直接指定协议，优先于 vendor 预设。 */
  readonly protocol?: ProtocolId;
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly model?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface ResolvedProvider {
  readonly vendorId: string;
  readonly protocol: ProtocolId;
  readonly modelId: string;
  readonly adapter: ProtocolAdapter;
  model(): LanguageModel;
}

/**
 * 解析配置 → 可用 provider。
 *
 * 若 `vendor` 未指定，按 `baseUrl` 猜测；都猜不出则用 `custom`。
 */
export function resolveProvider(opts: ResolveOptions): ResolvedProvider {
  const preset = opts.vendor === undefined ? null : getPreset(opts.vendor);

  if (opts.vendor !== undefined && preset === null) {
    throw new Error(
      `未知厂商：${opts.vendor}。可用：${listVendors()
        .map((v) => v.id)
        .join(', ')}`,
    );
  }

  const protocol: ProtocolId = opts.protocol ?? preset?.protocol ?? DEFAULT_PROTOCOL;
  const baseUrl = opts.baseUrl ?? preset?.baseUrl ?? '';
  const model = opts.model ?? preset?.defaultModel ?? '';

  if (baseUrl === '') {
    throw new Error(`厂商 ${opts.vendor ?? '(未指定)'} 缺少 baseUrl`);
  }
  if (model === '') {
    throw new Error(`厂商 ${opts.vendor ?? '(未指定)'} 缺少 model`);
  }

  const config: ProtocolConfig = {
    baseUrl,
    apiKey: opts.apiKey,
    model,
    ...(opts.headers === undefined && preset?.headers === undefined
      ? {}
      : { headers: { ...preset?.headers, ...opts.headers } }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  };

  const adapter = createAdapter(protocol, config);

  return {
    vendorId: opts.vendor ?? DEFAULT_VENDOR_ID,
    protocol,
    modelId: model,
    adapter,
    model: () => adapter.createModel(),
  };
}

/** 从环境变量解析，供 CLI / API 启动时使用。 */
export function resolveFromEnv(env: NodeJS.ProcessEnv = process.env): ResolvedProvider {
  const vendor = env.HARNESS_LLM_VENDOR ?? DEFAULT_VENDOR_ID;
  const protocol = env.HARNESS_LLM_PROTOCOL as ProtocolId | undefined;

  return resolveProvider({
    vendor,
    ...(protocol === undefined ? {} : { protocol }),
    ...(env.HARNESS_LLM_BASE_URL === undefined ? {} : { baseUrl: env.HARNESS_LLM_BASE_URL }),
    apiKey: env.HARNESS_LLM_API_KEY ?? '',
    ...(env.HARNESS_LLM_MODEL === undefined ? {} : { model: env.HARNESS_LLM_MODEL }),
  });
}

export type { ProtocolAdapter, ProtocolConfig, ProtocolId };
export { getPreset, listVendors };
