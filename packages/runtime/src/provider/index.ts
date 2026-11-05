/**
 * LLM 接入（
 *
 * 移植的三个核心设计：
 *
 * 1. **能力接口并列而非继承**。Harness 把 `Provider` / `STTProvider` / `EmbeddingProvider`
 *    拆成互不继承的并列分支。我们只需要 chat，但仍保留「能力标签」，
 *    这样将来加 embedding（规则向量检索）不用重构。
 *
 * 2. **注册表 + 三级解析链**。`registerProviderAdapter()` 把适配器写进注册表；
 *    解析时按「显式 id → 全局默认 → 首个可用」降级。调用方永远只写
 *    `resolveProvider(config)`，不关心有几个 provider。
 *
 * 3. **可选初始化用结构化类型**。Harness 用 `runtime_checkable Protocol`；
 *    TS 用鸭子类型守卫 `isInitializable()`。
 *
 * 与 Harness 的差异：
 * - Harness 有 6 类能力 + 会话级覆盖（umo），我们单用户单企业，砍掉会话级选择
 * - Harness 支持多 key 轮询、代理、headers 注入；我们保留 key 与 baseURL，砍掉轮询
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

/* ---------------------------- 能力接口 ---------------------------- */

export type ProviderType = 'chat';

/** 所有 provider 的公共元信息。 */
export interface ProviderMeta {
  readonly id: string;
  /** 适配器类型名，如 `openai-compatible`。 */
  readonly type: string;
  readonly desc: string;
  readonly providerType: ProviderType;
  readonly defaultModel: string;
}

/** 可选初始化：有 `initialize` 方法就会被调用（结构化类型，不靠继承）。 */
export interface Initializable {
  initialize(): Promise<void>;
}

export function isInitializable(x: unknown): x is Initializable {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { initialize?: unknown }).initialize === 'function'
  );
}

export interface ChatProvider {
  readonly kind: 'chat';
  meta(): ProviderMeta;
  /** 返回 AI SDK 的 LanguageModel 实例。 */
  createModel(modelId?: string): LanguageModel;
  /** 连通性检查，供 `harness doctor` 使用。 */
  test(): Promise<{ ok: boolean; latencyMs: number; message?: string }>;
}

export type AnyProvider = ChatProvider;

/* ---------------------------- 配置 ---------------------------- */

export interface ProviderConfig {
  readonly id: string;
  readonly type: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** 从环境变量读配置。密钥只在这里出现，不向下传递。 */
export function providerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const baseUrl = env.HARNESS_LLM_BASE_URL ?? '';
  const apiKey = env.HARNESS_LLM_API_KEY ?? '';
  const model = env.HARNESS_LLM_MODEL ?? '';
  return {
    id: 'default',
    type: 'openai-compatible',
    baseUrl,
    apiKey,
    model: model === '' ? 'gpt-4o-mini' : model,
  };
}

/* -------------------------- OpenAI 兼容 -------------------------- */

/**
 * OpenAI 兼容适配器。
 *
 * 适用于：OpenAI 官方、DeepSeek、通义、智谱、vLLM、Ollama(`/v1`)、
 * 以及任何 OpenAI-compatible 网关。
 */
export class OpenAICompatibleProvider implements ChatProvider, Initializable {
  readonly kind = 'chat' as const;

  constructor(private readonly config: ProviderConfig) {}

  meta(): ProviderMeta {
    return {
      id: this.config.id,
      type: this.config.type,
      desc: 'OpenAI 兼容端点',
      providerType: 'chat',
      defaultModel: this.config.model,
    };
  }

  async initialize(): Promise<void> {
    if (this.config.baseUrl === '') {
      throw new Error('HARNESS_LLM_BASE_URL 未配置');
    }
  }

  createModel(modelId?: string): LanguageModel {
    const factory = createOpenAICompatible({
      name: this.config.id,
      baseURL: this.config.baseUrl,
      apiKey: this.config.apiKey,
      ...(this.config.headers === undefined ? {} : { headers: this.config.headers }),
    });
    return factory.chatModel(modelId ?? this.config.model) as unknown as LanguageModel;
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message?: string }> {
    const t0 = Date.now();
    try {
      const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/models`, {
        headers: this.config.apiKey === '' ? {} : { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(8_000),
      });
      const latencyMs = Date.now() - t0;
      if (!res.ok) {
        return { ok: false, latencyMs, message: `HTTP ${res.status}` };
      }
      return { ok: true, latencyMs };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/* ---------------------------- 注册表 ---------------------------- */

export interface ProviderRegistration {
  readonly typeName: string;
  readonly desc: string;
  readonly factory: (config: ProviderConfig) => AnyProvider;
}

const REGISTRY = new Map<string, ProviderRegistration>();

export function registerProviderAdapter(reg: ProviderRegistration): void {
  if (REGISTRY.has(reg.typeName)) {
    throw new Error(`provider 适配器重复注册：${reg.typeName}`);
  }
  REGISTRY.set(reg.typeName, reg);
}

export function listProviderAdapters(): readonly ProviderRegistration[] {
  return [...REGISTRY.values()];
}

/** 内置注册（模块加载即完成，不靠外部调用）。 */
registerProviderAdapter({
  typeName: 'openai-compatible',
  desc: 'OpenAI 兼容端点（OpenAI / DeepSeek / vLLM / Ollama 等）',
  factory: (config) => new OpenAICompatibleProvider(config),
});

/* ---------------------------- 管理器 ---------------------------- */

/**
 * 三级解析链：显式 id → 全局默认 → 首个可用。
 *
 * 与 Harness `_resolve_using_provider` 同构，只是少了「会话级覆盖」这一层。
 */
export class ProviderManager {
  private readonly instances = new Map<string, AnyProvider>();

  async load(config: ProviderConfig): Promise<ChatProvider> {
    const reg = REGISTRY.get(config.type);
    if (reg === undefined) {
      throw new Error(
        `未知的 provider 类型：${config.type}。可用：${[...REGISTRY.keys()].join(', ')}`,
      );
    }
    const inst = reg.factory(config);
    if (isInitializable(inst)) await inst.initialize();
    this.instances.set(config.id, inst);
    return inst as ChatProvider;
  }

  resolve(id?: string): ChatProvider {
    if (id !== undefined) {
      const found = this.instances.get(id);
      if (found === undefined) throw new Error(`provider 未加载：${id}`);
      return found as ChatProvider;
    }
    const first = this.instances.values().next();
    if (first.done === true) throw new Error('没有可用的 provider，请先调用 load()');
    return first.value as ChatProvider;
  }

  list(): readonly ProviderMeta[] {
    return [...this.instances.values()].map((p) => p.meta());
  }
}
