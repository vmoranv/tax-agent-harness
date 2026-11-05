/**
 * 财税 Harness 后端 API 层。
 *
 * 后端端点（apps/api，Fastify，默认 :9601）：
 * - GET  /health                       → { ok, mode }
 * - GET  /api/users                    → { users: [{id, display_name}] }
 * - GET  /api/enterprises              → { enterprises: [{id, legal_name}] }
 * - GET  /api/rules                    → { rules: [{code, version, title, status, effective_from}] }
 * - POST /api/chat                     → 在线模式（需模型）{ runId, text, degraded, toolCallCount }
 * - POST /api/chat/script              → 演示模式（脚本驱动真实工具）{ text, steps }
 * - GET  /api/trace                    → { runs: [...] }
 * - GET  /api/trace/:runId             → 完整运行记录
 */

import axios from 'axios';

/** axios 请求超时（毫秒）：评测脚本 / 模型调用可能较慢，留足余量。 */
const HTTP_TIMEOUT_MS = 120_000;
/** 运行记录列表默认返回条数。 */
const DEFAULT_TRACE_LIMIT = 20;
/** 控制台实时日志默认拉取条数。 */
const DEFAULT_RECENT_LOG_LIMIT = 200;
/** 数据表分页的默认每页条数 / 默认偏移。 */
const DEFAULT_TABLE_LIMIT = 100;
const DEFAULT_TABLE_OFFSET = 0;

const http = axios.create({
  baseURL: '/',
  timeout: HTTP_TIMEOUT_MS,
});

/* ------------------------------ 元数据 ------------------------------ */

export interface UserMeta {
  id: string;
  display_name: string;
}

export interface EnterpriseMeta {
  id: string;
  legal_name: string;
}

export interface RuleObligation {
  kind: string;
  summary: string;
}

export interface RuleMeta {
  code: string;
  version: string;
  title: string;
  category: string;
  scope: string;
  status: string;
  effective_from: string;
  body: string;
  obligation: RuleObligation | null;
}

export async function fetchUsers(): Promise<UserMeta[]> {
  const r = await http.get<{ users: UserMeta[] }>('/api/users');
  return r.data.users ?? [];
}

export async function fetchEnterprises(): Promise<EnterpriseMeta[]> {
  const r = await http.get<{ enterprises: EnterpriseMeta[] }>('/api/enterprises');
  return r.data.enterprises ?? [];
}

export async function fetchRules(): Promise<RuleMeta[]> {
  const r = await http.get<{ rules: RuleMeta[] }>('/api/rules');
  return r.data.rules ?? [];
}

/* ------------------------------ 对话 ------------------------------ */

export interface ToolResultItem {
  name: string;
  ok: boolean;
  data: unknown;
}

export interface ToolCallDto {
  id: string;
  name: string;
  ok: boolean;
  result: unknown;
  elapsedMs: number;
}

export interface ProvenanceDto {
  literal: string;
  source: string;
  ok: boolean;
}

export interface LiveChatResult {
  runId: string;
  text: string;
  degraded: boolean;
  toolCallCount: number;
  steps: ToolCallDto[];
  provenance: ProvenanceDto[];
}

export interface ScriptChatResult {
  runId: string;
  text: string;
  toolCallCount: number;
  steps: ToolResultItem[];
}

/** 在线模式：需要后端配置了模型。 */
export async function chatLive(input: {
  text: string;
  userId: string;
  enterpriseId: string;
}): Promise<LiveChatResult> {
  const r = await http.post('/api/chat', {
    text: input.text,
    userId: input.userId,
    enterpriseId: input.enterpriseId,
  });
  return r.data;
}

/** 演示模式：脚本驱动真实工具（不经过模型理解，返回的是程序真实计算结果）。 */
export async function chatScript(input: {
  text: string;
  userId: string;
  enterpriseId: string;
  turns: Array<
    Array<{ type: 'text' | 'tool-call'; content?: string; name?: string; args?: unknown }>
  >;
}): Promise<ScriptChatResult> {
  const r = await http.post('/api/chat/script', input);
  return r.data;
}

/** 离线自由对话：自然语言路由到真实用例（无 LLM）。 */
export interface OfflineChatResult {
  runId: string | null;
  text: string;
  toolCallCount: number;
  steps: ToolResultItem[];
  clarified: boolean;
}

export async function chatOffline(input: {
  text: string;
  userId: string;
  enterpriseId: string;
}): Promise<OfflineChatResult> {
  const r = await http.post('/api/chat/offline', input);
  return r.data;
}

/* ------------------------------ 运行记录 ------------------------------ */

export interface TraceSummary {
  run_id: string;
  started_at: string;
  final_preview: string;
  has_error: number;
}

export async function listTraces(limit = DEFAULT_TRACE_LIMIT): Promise<TraceSummary[]> {
  const r = await http.get<{ runs: TraceSummary[] }>('/api/trace', { params: { limit } });
  return r.data.runs ?? [];
}

/** /api/trace/:runId 返回的 TraceRunSnapshot（camelCase）。 */
export interface TraceDetailDto {
  runId: string;
  sessionId: string | null;
  userId: string | null;
  enterpriseId: string | null;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number;
  model: { providerId: string; modelId: string };
  context: {
    instructions: string;
    rules: Array<{ code: string; version: string }>;
    estimatedTokens: number;
    degradeLevel: string;
  } | null;
  steps: Array<{
    index: number;
    kind: string;
    at: string;
    elapsedMs: number;
    sinceStartMs: number;
    payload: unknown;
  }>;
  toolCalls: Array<{
    id: string;
    name: string;
    args: unknown;
    ok: boolean;
    result: unknown;
    elapsedMs: number;
    errorCode?: string;
  }>;
  provenance: Array<{ literal: string; source: string; ok: boolean }>;
  /** 真实模型 token 消耗（AI SDK totalUsage）。 */
  usage: { inputTokens: number; outputTokens: number };
  finalText: string;
  error: { code: string; message: string } | null;
}

export async function fetchTraceDetail(runId: string): Promise<TraceDetailDto> {
  const r = await http.get<TraceDetailDto>(`/api/trace/${encodeURIComponent(runId)}`);
  return r.data;
}

/* ------------------------------ SSE 流式 ------------------------------ */

export interface StreamHandlers {
  onStarted?: (runId: string) => void;
  onTool?: (name: string, ok: boolean) => void;
  onDone?: (runId: string, text: string) => void;
  onError?: (message: string) => void;
}

/**
 * 在线模式的 SSE 流式对话。
 *
 * 用原生 EventSource（GET + 查询参数，后端已按此设计）。
 * 返回关闭函数；组件卸载或完成时调用。
 */
export function chatStream(
  input: { text: string; userId: string; enterpriseId: string },
  h: StreamHandlers,
): () => void {
  const qs = new URLSearchParams({
    text: input.text,
    userId: input.userId,
    enterpriseId: input.enterpriseId,
  });
  const es = new EventSource(`/api/chat/stream?${qs.toString()}`);

  es.addEventListener('run.started', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { runId: string };
    h.onStarted?.(d.runId);
  });
  es.addEventListener('tool', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { name: string; ok: boolean };
    h.onTool?.(d.name, d.ok);
  });
  es.addEventListener('done', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { runId: string; text: string };
    h.onDone?.(d.runId, d.text);
    es.close();
  });
  es.addEventListener('error', () => {
    // SSE 连接层错误（后端会另发 event: error 业务错误）
    h.onError?.('连接中断或后端错误');
    es.close();
  });

  // 后端业务错误也通过 event: error 传递（无 data 时上面已处理）
  es.addEventListener('error', ((e: MessageEvent) => {
    if (e?.data) {
      const d = JSON.parse(e.data) as { message: string };
      h.onError?.(d.message);
      es.close();
    }
  }) as EventListener);

  return () => es.close();
}

/* ------------------------------ 健康检查 ------------------------------ */

export interface HealthInfo {
  ok: boolean;
  mode: string;
  llm: { configured: boolean; vendor: string; model: string };
}

export async function fetchHealth(): Promise<HealthInfo> {
  const r = await http.get('/health');
  return r.data;
}

export interface TaskItemDto {
  ref: string;
  state: 'pending' | 'done' | 'skipped';
  note: string | null;
  updatedAt: string;
}

export interface TaskCardDto {
  id: string;
  userId: string;
  enterpriseId: string;
  month: string;
  status: 'active' | 'completed' | 'abandoned';
  pending: TaskItemDto[];
  completed: TaskItemDto[];
  note: string | null;
  revision: number;
  openedAt: string;
  updatedAt: string;
}

export async function fetchTaskCard(
  userId: string,
  enterpriseId: string,
): Promise<TaskCardDto | null> {
  const r = await http.get<{ taskCard: TaskCardDto | null }>('/api/task-card', {
    params: { userId, enterpriseId },
  });
  return r.data.taskCard ?? null;
}

/* ------------------------------ 模型服务商与平台 ------------------------------ */

export interface VendorPresetDto {
  id: string;
  label: string;
  protocol: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';
  supportsTools: boolean;
  baseUrl: string;
  defaultModel: string;
}

export interface ProviderResponseDto {
  current: {
    configured: boolean;
    vendor: string;
    model: string;
    baseUrl: string;
  };
  vendors: VendorPresetDto[];
}

export interface PlatformConfigField {
  key: string;
  label: string;
  required: boolean;
  secret?: boolean;
  placeholder?: string;
  defaultValue?: string;
}

export interface PlatformDto {
  id: string;
  name: string;
  type: string;
  category: string;
  icon: string;
  authType: string;
  webhookPath: string;
  status: string;
  description: string;
  features: string[];
  configFields: PlatformConfigField[];
}

export async function fetchProviders(): Promise<ProviderResponseDto> {
  const r = await http.get<ProviderResponseDto>('/api/providers');
  return r.data;
}

export async function testProvider(payload: {
  vendor?: string;
  protocol?: string;
  baseUrl?: string;
  apiKey: string;
  model?: string;
}): Promise<{
  ok: boolean;
  latencyMs: number;
  message?: string;
  model?: string;
  protocol?: string;
}> {
  const r = await http.post('/api/providers/test', payload);
  return r.data;
}

export async function fetchPlatforms(): Promise<{ platforms: PlatformDto[] }> {
  const r = await http.get<{ platforms: PlatformDto[] }>('/api/platforms');
  return r.data;
}

/* ------------------------------ 实时日志控制台 ------------------------------ */

export interface LogEntryDto {
  level: 'debug' | 'info' | 'warn' | 'error';
  time: string;
  msg: string;
  context: {
    runId?: string;
    sessionId?: string;
    userId?: string;
    enterpriseId?: string;
    fields?: Record<string, unknown>;
  };
  fields?: Record<string, unknown>;
  error?: { name: string; message: string; stack?: string };
}

export async function fetchRecentLogs(limit = DEFAULT_RECENT_LOG_LIMIT): Promise<LogEntryDto[]> {
  const r = await http.get<{ logs: LogEntryDto[] }>('/api/console/logs/recent', {
    params: { limit },
  });
  return r.data.logs ?? [];
}

/** SSE 订阅实时日志；返回关闭函数。可选生命周期回调供控制台实现重连/状态指示。 */
export function streamLogs(
  onLog: (e: LogEntryDto) => void,
  handlers: { onOpen?: () => void; onError?: () => void } = {},
): () => void {
  const es = new EventSource('/api/console/logs/stream');
  es.addEventListener('log', (e) => {
    onLog(JSON.parse((e as MessageEvent).data) as LogEntryDto);
  });
  es.addEventListener('open', () => handlers.onOpen?.());
  es.addEventListener('error', () => handlers.onError?.());
  return () => es.close();
}

/* ------------------------------ 评测中台 ------------------------------ */

export interface EvalOfficialDimension {
  key: string;
  name: string;
  weight: number;
  look: string;
}

export interface EvalDimension {
  name: string;
  desc: string;
  target: number;
  taggedCount: number;
  uniqueCases: number;
  pass: number;
  fail: number;
  score: number | null;
  health: string;
}

export interface EvalLayer {
  total: number;
  pass: number;
  fail: number;
  blocked: number;
  pending: number;
  unverified: number;
  manual: number;
}

export interface EvalCaseResult {
  layer: string;
  id: string;
  title: string;
  status: string;
  failures: string[];
  dimensions: string[];
}
/** 规则检索效果（确定性检索 IR 指标，非向量）。 */
export interface EvalRetrievalQuery {
  enterprise: string;
  month: string;
  gold: string[];
  retrieved: string[];
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  versionExact: boolean;
}

export interface EvalRetrievalMetrics {
  available: boolean;
  reason?: string;
  macro: {
    precision: number;
    recall: number;
    f1: number;
    versionHitRate: number;
    queryCount: number;
    candidateCount: number;
    micro: { precision: number; recall: number; f1: number; tp: number; fp: number; fn: number };
  } | null;
  queries: EvalRetrievalQuery[];
  generatedAt?: string;
}

export interface EvalReport {
  officialDimensions: EvalOfficialDimension[];
  disclaimer: string;
  golden: { ok: boolean; problems: string[] };
  total: number;
  byStatus: Record<string, number>;
  byLayer: Record<string, EvalLayer>;
  dimensions: Record<string, EvalDimension>;
  retrieval: EvalRetrievalMetrics;
  results: EvalCaseResult[];
}

export async function fetchEvalReport(refresh = false): Promise<EvalReport> {
  const r = await http.get<EvalReport>('/api/eval/report', {
    params: refresh ? { refresh: 1 } : {},
  });
  return r.data;
}

/* ------------------------------ 数据中台 ------------------------------ */

export interface DataTableMeta {
  name: string;
  label: string;
  count: number;
}

export interface DataOverview {
  tables: DataTableMeta[];
  totals: Record<string, number>;
  generatedAt: string;
}

export interface DataTableResult {
  name: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  total: number;
}

export async function fetchDataOverview(): Promise<DataOverview> {
  const r = await http.get<DataOverview>('/api/data/overview');
  return r.data;
}

export async function fetchDataTable(
  name: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<DataTableResult> {
  const r = await http.get<DataTableResult>(`/api/data/table/${encodeURIComponent(name)}`, {
    params: {
      limit: opts.limit ?? DEFAULT_TABLE_LIMIT,
      offset: opts.offset ?? DEFAULT_TABLE_OFFSET,
    },
  });
  return r.data;
}
