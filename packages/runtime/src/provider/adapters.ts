/**
 * 四套协议适配器。
 *
 * 设计原则：**协议差异交给官方 SDK 处理**，我们不手写 HTTP。
 * 手写 Claude 的 `tool_use` 结构或 Gemini 的 `functionCall` 结构极易出错，
 * 而且 SDK 会跟进协议变更。
 *
 * 覆盖范围：
 * - `openai-chat`      → 40 个厂商（OpenAI 兼容，包括所有中转网关）
 * - `openai-responses` → OpenAI `/v1/responses`
 * - `anthropic`        → Claude Messages API
 * - `gemini`           → Google generateContent
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ProtocolAdapter, ProtocolConfig, ProtocolId } from './protocol.js';

/** Anthropic Messages API 版本头，所有 Anthropic 请求共用。 */
const ANTHROPIC_VERSION = '2023-06-01';
/** 连通性探测请求的超时上限（毫秒）。 */
const PROBE_TIMEOUT_MS = 8_000;

/** 四个 adapter 的 probe() 与共享探测逻辑共用的返回结构。 */
type ProbeResult = {
  ok: boolean;
  latencyMs: number;
  supportsTools: boolean;
  message?: string;
};

/* ------------------------ OpenAI Chat Completions ------------------------ */

export class OpenAIChatAdapter implements ProtocolAdapter {
  readonly protocol: ProtocolId = 'openai-chat';

  constructor(readonly config: ProtocolConfig) {}

  createModel(modelId?: string): LanguageModel {
    const factory = createOpenAICompatible({
      name: 'openai-chat',
      baseURL: this.config.baseUrl,
      apiKey: this.config.apiKey,
      ...(this.config.headers === undefined ? {} : { headers: this.config.headers }),
    });
    return factory.chatModel(modelId ?? this.config.model) as unknown as LanguageModel;
  }

  async probe(): Promise<ProbeResult> {
    return probeModelsEndpoint(this.config, []);
  }
}

/* -------------------------- OpenAI Responses -------------------------- */

export class OpenAIResponsesAdapter implements ProtocolAdapter {
  readonly protocol: ProtocolId = 'openai-responses';

  constructor(readonly config: ProtocolConfig) {}

  createModel(modelId?: string): LanguageModel {
    const factory = createOpenAI({
      baseURL: this.config.baseUrl,
      apiKey: this.config.apiKey,
      ...(this.config.headers === undefined ? {} : { headers: this.config.headers }),
    });
    // Responses API 用 `responses()`，不是 `chat()`
    return factory.responses(modelId ?? this.config.model) as unknown as LanguageModel;
  }

  async probe(): Promise<ProbeResult> {
    return probeModelsEndpoint(this.config, []);
  }
}

/* ----------------------------- Anthropic ----------------------------- */

export class AnthropicAdapter implements ProtocolAdapter {
  readonly protocol: ProtocolId = 'anthropic';

  constructor(readonly config: ProtocolConfig) {}

  createModel(modelId?: string): LanguageModel {
    const factory = createAnthropic({
      baseURL: this.config.baseUrl,
      apiKey: this.config.apiKey,
      headers: {
        'anthropic-version': ANTHROPIC_VERSION,
        ...this.config.headers,
      },
    });
    return factory.languageModel(modelId ?? this.config.model) as unknown as LanguageModel;
  }

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/v1/models`, {
        headers: {
          'x-api-key': this.config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return {
        ok: res.ok,
        latencyMs: Date.now() - t0,
        supportsTools: true,
        ...(res.ok ? {} : { message: `HTTP ${res.status}` }),
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        supportsTools: true,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/* ------------------------------- Gemini ------------------------------- */

export class GeminiAdapter implements ProtocolAdapter {
  readonly protocol: ProtocolId = 'gemini';

  constructor(readonly config: ProtocolConfig) {}

  createModel(modelId?: string): LanguageModel {
    const factory = createGoogleGenerativeAI({
      baseURL: this.config.baseUrl,
      apiKey: this.config.apiKey,
      ...(this.config.headers === undefined ? {} : { headers: this.config.headers }),
    });
    return factory(modelId ?? this.config.model) as unknown as LanguageModel;
  }

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const url = `${this.config.baseUrl.replace(/\/$/, '')}/models?key=${encodeURIComponent(this.config.apiKey)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return {
        ok: res.ok,
        latencyMs: Date.now() - t0,
        supportsTools: true,
        ...(res.ok ? {} : { message: `HTTP ${res.status}` }),
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        supportsTools: true,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/* ---------------------------- 共享探测逻辑 ---------------------------- */

async function probeModelsEndpoint(
  config: ProtocolConfig,
  _unused: unknown[],
): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/models`, {
      headers: config.apiKey === '' ? {} : { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return {
      ok: res.ok,
      latencyMs: Date.now() - t0,
      supportsTools: true,
      ...(res.ok ? {} : { message: `HTTP ${res.status}` }),
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      supportsTools: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ------------------------------ 工厂 ------------------------------ */

export function createAdapter(protocol: ProtocolId, config: ProtocolConfig): ProtocolAdapter {
  switch (protocol) {
    case 'openai-chat':
      return new OpenAIChatAdapter(config);
    case 'openai-responses':
      return new OpenAIResponsesAdapter(config);
    case 'anthropic':
      return new AnthropicAdapter(config);
    case 'gemini':
      return new GeminiAdapter(config);
  }
}
