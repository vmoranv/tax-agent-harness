/**
 * Provider 协议层。
 *
 * 核心洞察（分析 Harness 47 个 provider 源码后得出）：
 * **47 个厂商只有 4 套协议**，其余都是 baseURL + 默认模型的差异。
 *
 * | 协议 | 厂商数 | 特点 |
 * |---|---|---|
 * | openai-chat | ~40 | chat completions，`tools` / `tool_calls` |
 * | openai-responses | 1 | `/v1/responses`，`input` / `output` |
 * | anthropic | 1 | Messages API，`tool_use` / `tool_result` |
 * | gemini | 1 | `generateContent`，`functionCall` / `functionResponse` |
 *
 * 因此实现 4 个协议适配器 + 一张厂商预设表，即可覆盖全部。
 */

import type { LanguageModel } from 'ai';

/** 协议标识（不是厂商标识）。 */
export type ProtocolId = 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';

/** 厂商预设：一行切换厂商，无需改代码。 */
export interface VendorPreset {
  readonly id: string;
  readonly label: string;
  readonly protocol: ProtocolId;
  readonly baseUrl: string;
  readonly defaultModel: string;
  /** 该厂商是否支持工具调用（决定能否跑 agent loop）。 */
  readonly supportsTools: boolean;
  /** 额外请求头，如 Anthropic 的 `anthropic-version`。 */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * 40 个厂商预设。
 *
 * 说明：这里只列常用厂商；其余 LongCat / MiMo / SSYCloud 等小众厂商
 * 用户可直接指定 `protocol` + `baseUrl` + `model` 三个值接入。
 */
export const VENDOR_PRESETS: Readonly<Record<string, VendorPreset>> = {
  /* ---------- 一线厂商（原生协议） ---------- */
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5-5',
    supportsTools: true,
    headers: { 'anthropic-version': '2023-06-01' },
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    supportsTools: true,
  },
  'openai-chat': {
    id: 'openai-chat',
    label: 'OpenAI (Chat Completions)',
    protocol: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    supportsTools: true,
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-flash',
    supportsTools: true,
  },

  /* ---------- 国内厂商（OpenAI 兼容） ---------- */
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    supportsTools: true,
  },
  zhipu: {
    id: 'zhipu',
    label: '智谱 GLM',
    protocol: 'openai-chat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
    supportsTools: true,
  },
  moonshot: {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    protocol: 'openai-chat',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    supportsTools: true,
  },
  qwen: {
    id: 'qwen',
    label: '阿里通义千问',
    protocol: 'openai-chat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    supportsTools: true,
  },
  baichuan: {
    id: 'baichuan',
    label: '百川',
    protocol: 'openai-chat',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    defaultModel: 'Baichuan4',
    supportsTools: true,
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    protocol: 'openai-chat',
    baseUrl: 'https://api.minimax.chat/v1',
    defaultModel: 'abab6.5s-chat',
    supportsTools: true,
  },
  hunyuan: {
    id: 'hunyuan',
    label: '腾讯混元',
    protocol: 'openai-chat',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    defaultModel: 'hunyuan-turbo',
    supportsTools: true,
  },
  doubao: {
    id: 'doubao',
    label: '字节豆包',
    protocol: 'openai-chat',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-pro-32k',
    supportsTools: true,
  },
  sensetime: {
    id: 'sensetime',
    label: '商汤日日新',
    protocol: 'openai-chat',
    baseUrl: 'https://api.sensenova.cn/compatible-mode/v1',
    defaultModel: 'SenseChat-5',
    supportsTools: true,
  },
  stepfun: {
    id: 'stepfun',
    label: '阶跃星辰',
    protocol: 'openai-chat',
    baseUrl: 'https://api.stepfun.com/v1',
    defaultModel: 'step-1-8k',
    supportsTools: true,
  },
  'yi-lingyiwanwu': {
    id: 'yi-lingyiwanwu',
    label: '零一万物 Yi',
    protocol: 'openai-chat',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    defaultModel: 'yi-large',
    supportsTools: true,
  },

  /* ---------- 海外厂商（OpenAI 兼容） ---------- */
  groq: {
    id: 'groq',
    label: 'Groq',
    protocol: 'openai-chat',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    supportsTools: true,
  },
  xai: {
    id: 'xai',
    label: 'xAI Grok',
    protocol: 'openai-chat',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
    supportsTools: true,
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    protocol: 'openai-chat',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    supportsTools: true,
  },
  together: {
    id: 'together',
    label: 'Together AI',
    protocol: 'openai-chat',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    supportsTools: true,
  },
  fireworks: {
    id: 'fireworks',
    label: 'Fireworks',
    protocol: 'openai-chat',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    supportsTools: true,
  },
  perplexity: {
    id: 'perplexity',
    label: 'Perplexity',
    protocol: 'openai-chat',
    baseUrl: 'https://api.perplexity.ai',
    defaultModel: 'sonar-pro',
    supportsTools: false,
  },
  deepinfra: {
    id: 'deepinfra',
    label: 'DeepInfra',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
    supportsTools: true,
  },
  cerebras: {
    id: 'cerebras',
    label: 'Cerebras',
    protocol: 'openai-chat',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama3.3-70b',
    supportsTools: true,
  },
  sambanova: {
    id: 'sambanova',
    label: 'SambaNova',
    protocol: 'openai-chat',
    baseUrl: 'https://api.sambanova.ai/v1',
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
    supportsTools: true,
  },
  hyperbolic: {
    id: 'hyperbolic',
    label: 'Hyperbolic',
    protocol: 'openai-chat',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    supportsTools: true,
  },
  novita: {
    id: 'novita',
    label: 'Novita AI',
    protocol: 'openai-chat',
    baseUrl: 'https://api.novita.ai/v3/openai',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    supportsTools: true,
  },

  /* ---------- 聚合网关 ---------- */
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4',
    supportsTools: true,
  },
  'azure-openai': {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    protocol: 'openai-chat',
    baseUrl: 'https://YOUR.openai.azure.com/openai/deployments/YOUR',
    defaultModel: 'gpt-4o',
    supportsTools: true,
  },
  aihubmix: {
    id: 'aihubmix',
    label: 'AIHubMix',
    protocol: 'openai-chat',
    baseUrl: 'https://aihubmix.com/v1',
    defaultModel: 'gpt-4o',
    supportsTools: true,
  },
  oneapi: {
    id: 'oneapi',
    label: 'OneAPI / NewAPI',
    protocol: 'openai-chat',
    baseUrl: 'http://localhost:3000/v1',
    defaultModel: 'gpt-4o',
    supportsTools: true,
  },
  siliconflow: {
    id: 'siliconflow',
    label: '硅基流动',
    protocol: 'openai-chat',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-72B-Instruct',
    supportsTools: true,
  },

  /* ---------- 本地部署 ---------- */
  ollama: {
    id: 'ollama',
    label: 'Ollama（本地）',
    protocol: 'openai-chat',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5:7b',
    supportsTools: true,
  },
  vllm: {
    id: 'vllm',
    label: 'vLLM（自建）',
    protocol: 'openai-chat',
    baseUrl: 'http://localhost:8000/v1',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
    supportsTools: true,
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio（本地）',
    protocol: 'openai-chat',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    supportsTools: true,
  },
  xinference: {
    id: 'xinference',
    label: 'Xinference',
    protocol: 'openai-chat',
    baseUrl: 'http://localhost:9997/v1',
    defaultModel: 'qwen2.5-instruct',
    supportsTools: true,
  },
  localai: {
    id: 'localai',
    label: 'LocalAI',
    protocol: 'openai-chat',
    baseUrl: 'http://localhost:8080/v1',
    defaultModel: 'gpt-4',
    supportsTools: true,
  },
  llamacpp: {
    id: 'llamacpp',
    label: 'llama.cpp server',
    protocol: 'openai-chat',
    baseUrl: 'http://localhost:8081/v1',
    defaultModel: 'local',
    supportsTools: true,
  },
  textgenwebui: {
    id: 'textgenwebui',
    label: 'Text Generation WebUI',
    protocol: 'openai-chat',
    baseUrl: 'http://localhost:5000/v1',
    defaultModel: 'local',
    supportsTools: false,
  },

  /* ---------- 更多国内/海外厂商 ---------- */
  spark: {
    id: 'spark',
    label: '科大讯飞星火',
    protocol: 'openai-chat',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    defaultModel: 'generalv3.5',
    supportsTools: true,
  },
  ernie: {
    id: 'ernie',
    label: '百度文心一言',
    protocol: 'openai-chat',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    defaultModel: 'ernie-4.0-8k',
    supportsTools: true,
  },
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    protocol: 'openai-chat',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.1-70b-instruct',
    supportsTools: true,
  },
  cohere: {
    id: 'cohere',
    label: 'Cohere',
    protocol: 'openai-chat',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    defaultModel: 'command-r-plus',
    supportsTools: true,
  },
  replicate: {
    id: 'replicate',
    label: 'Replicate',
    protocol: 'openai-chat',
    baseUrl: 'https://api.replicate.com/v1',
    defaultModel: 'meta/meta-llama-3-70b-instruct',
    supportsTools: false,
  },

  /* ---------- 自建 / 中转 ---------- */
  custom: {
    id: 'custom',
    label: '自定义端点',
    protocol: 'openai-chat',
    baseUrl: 'http://localhost:8000/v1',
    defaultModel: 'custom-model',
    supportsTools: true,
  },
} as const;

export function getPreset(vendor: string): VendorPreset | null {
  return VENDOR_PRESETS[vendor] ?? null;
}

export function listVendors(): Array<{
  id: string;
  label: string;
  protocol: ProtocolId;
  supportsTools: boolean;
}> {
  return Object.values(VENDOR_PRESETS).map((v) => ({
    id: v.id,
    label: v.label,
    protocol: v.protocol,
    supportsTools: v.supportsTools,
  }));
}

/* ------------------------ 协议适配器接口 ------------------------ */

export interface ProtocolConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/**
 * 四套协议的统一出口。
 *
 * 注意：`createModel()` 返回 AI SDK 的 LanguageModel —— 但 Anthropic/Gemini
 * 需要各自的 SDK 包，或者走 AI SDK 的 provider 包。这里返回 `LanguageModel`
 * 是为了让 agent loop 无需关心底层协议。
 */
export interface ProtocolAdapter {
  readonly protocol: ProtocolId;
  readonly config: ProtocolConfig;
  createModel(modelId?: string): LanguageModel;
  /** 连通性与工具调用能力探测。 */
  probe(): Promise<{ ok: boolean; latencyMs: number; supportsTools: boolean; message?: string }>;
}

export type ProtocolFactory = (config: ProtocolConfig) => ProtocolAdapter;
