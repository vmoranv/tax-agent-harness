/**
 * 运行记录（
 *
 * Harness 用 OpenTelemetry 的 span 树 + SQLite 批量写。这里保留**语义**，
 * 去掉 OTel 依赖（比赛场景不需要导出到 Jaeger 之类）：
 *
 * | Harness | 本实现 |
 * |---|---|
 * | `TraceSpan`（OTel span 包装） | `TraceRun`（纯数据结构） |
 * | `trace.record(action, **fields)` | `run.record(kind, payload)` |
 * | `trace_execution()` 上下文管理器 | `withRun()` 包裹 |
 * | `TraceStore`（SQLite 批量、prune、中断标记） | `TraceStore`（同样的批量 + prune） |
 * | `_interrupt_inactive()` 标记进程崩溃 | `markInterrupted()` 同样处理 |
 *
 * 与赛题的相关性：R6 要求「能查看本轮模型输入、选用的记忆与规则、工具调用及结果」。
 * 所以 `TraceRun` 必须记录 `context.instructions` 全文，而不只是工具调用。
 */

import type { ProvenanceRecordDto, ToolCallRecordDto, TraceContextDto } from '@harness/contracts';

export type StepKind =
  | 'run.start'
  | 'context.assembled'
  | 'model.call'
  | 'tool.call'
  | 'tool.result'
  | 'provenance.check'
  | 'reply.rendered'
  | 'memory.write'
  | 'run.end'
  | 'run.error';

export interface TraceStep {
  readonly index: number;
  readonly kind: StepKind;
  readonly at: string;
  /** 本步真实耗时（距上一步结束的 duration，毫秒）。 */
  readonly elapsedMs: number;
  /** 距 run 开始的累计毫秒（时间线位置，用于回放排序）。 */
  readonly sinceStartMs: number;
  readonly payload: unknown;
}

export interface TraceRunSnapshot {
  readonly runId: string;
  readonly sessionId: string | null;
  readonly userId: string | null;
  readonly enterpriseId: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly elapsedMs: number;
  readonly model: { providerId: string; modelId: string };
  readonly context: TraceContextDto | null;
  readonly steps: readonly TraceStep[];
  readonly toolCalls: readonly ToolCallRecordDto[];
  readonly provenance: readonly ProvenanceRecordDto[];
  /** 真实模型 token 消耗（来自 AI SDK totalUsage，非启发式估算）。 */
  readonly usage: { inputTokens: number; outputTokens: number };
  /** step 数超 MAX_STEPS 被截断时为 true。 */
  readonly stepsTruncated: boolean;
  readonly finalText: string;
  readonly error: { code: string; message: string } | null;
}

const MAX_STEPS = 500;
const MAX_TEXT = 20_000;

function clip(s: string, max = MAX_TEXT): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[已截断 ${s.length - max} 字]`;
}

/**
 * 单轮运行记录。
 *
 * 生命周期：`start()` → 若干 `record()` → `finish()` / `fail()`。
 * 记录是**追加式**的，不允许修改已写入的步骤 —— 这样回放时才可信。
 */
export class TraceRun {
  private readonly steps: TraceStep[] = [];
  private readonly tools: ToolCallRecordDto[] = [];
  private provenanceRows: ProvenanceRecordDto[] = [];
  private contextDto: TraceContextDto | null = null;
  private finalText = '';
  private finishedAt: string | null = null;
  private failure: { code: string; message: string } | null = null;
  private readonly startMs: number;
  private readonly startedAt: string;
  /** 上一步 record 的时刻，用于计算每步真实 duration。 */
  private lastRecordMs: number;
  private usageDto: { inputTokens: number; outputTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
  };
  private stepsTruncated = false;

  constructor(
    readonly runId: string,
    readonly model: { providerId: string; modelId: string },
    private readonly sessionId: string | null = null,
    private readonly userId: string | null = null,
    private readonly enterpriseId: string | null = null,
  ) {
    this.startMs = Date.now();
    this.lastRecordMs = this.startMs;
    this.startedAt = new Date(this.startMs).toISOString();
  }

  static start(input: {
    runId: string;
    providerId: string;
    modelId: string;
    sessionId?: string | null;
    userId?: string | null;
    enterpriseId?: string | null;
  }): TraceRun {
    const run = new TraceRun(
      input.runId,
      { providerId: input.providerId, modelId: input.modelId },
      input.sessionId ?? null,
      input.userId ?? null,
      input.enterpriseId ?? null,
    );
    run.record('run.start', { runId: input.runId });
    return run;
  }

  /** 追加一步。超过上限后丢弃并标记截断。 */
  record(kind: StepKind, payload: unknown): void {
    if (this.steps.length >= MAX_STEPS) {
      this.stepsTruncated = true;
      return;
    }
    const now = Date.now();
    this.steps.push({
      index: this.steps.length,
      kind,
      at: new Date(now).toISOString(),
      // 本步真实耗时 = 距上一步结束的 duration；sinceStartMs = 时间线累计位置。
      elapsedMs: now - this.lastRecordMs,
      sinceStartMs: now - this.startMs,
      payload:
        typeof payload === 'string'
          ? clip(payload)
          : (JSON.parse(clip(JSON.stringify(payload))) as unknown),
    });
    this.lastRecordMs = now;
  }

  /** 记录本轮送进模型的完整上下文（R4 的核心证据）。 */
  setContext(ctx: TraceContextDto): void {
    this.contextDto = {
      ...ctx,
      instructions: clip(ctx.instructions),
    };
    this.record('context.assembled', {
      instructionsHash: ctx.instructionsHash,
      rules: ctx.rules.map((r) => `${r.code}@${r.version}`),
      estimatedTokens: ctx.estimatedTokens,
      degradeLevel: ctx.degradeLevel,
    });
  }

  addToolCall(call: ToolCallRecordDto): void {
    this.tools.push(call);
    this.record('tool.call', { id: call.id, name: call.name, args: call.args });
    this.record('tool.result', {
      id: call.id,
      ok: call.ok,
      elapsedMs: call.elapsedMs,
      errorCode: call.errorCode ?? null,
    });
  }

  setProvenance(rows: readonly ProvenanceRecordDto[]): void {
    this.provenanceRows = [...rows];
    this.record('provenance.check', {
      total: rows.length,
      failed: rows.filter((r) => !r.ok).map((r) => r.literal),
    });
  }

  setFinalText(text: string): void {
    this.finalText = clip(text);
  }

  /** 真实模型 token 消耗（由 executeStage 从 AI SDK totalUsage 透传）。 */
  setUsage(usage: { inputTokens: number; outputTokens: number }): void {
    this.usageDto = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  }

  /** 模型决策开始（补 StepKind.model.call，此前声明却从不 emit）。 */
  recordModelCall(meta: { stepCount: number; maxSteps: number }): void {
    this.record('model.call', { ...meta });
  }

  /** 回复渲染完成（补 StepKind.reply.rendered）。 */
  recordReplyRendered(meta: { textLength: number; truncated: boolean }): void {
    this.record('reply.rendered', { ...meta });
  }

  /** 会话历史写入（补 StepKind.memory.write）。 */
  recordMemoryWrite(meta: { turns: number }): void {
    this.record('memory.write', { ...meta });
  }

  finish(): void {
    if (this.finishedAt !== null) return;
    this.record('run.end', { elapsedMs: Date.now() - this.startMs });
    this.finishedAt = new Date().toISOString();
  }

  fail(code: string, message: string): void {
    if (this.finishedAt !== null) return;
    this.failure = { code, message };
    this.record('run.error', { code, message });
    this.finishedAt = new Date().toISOString();
  }

  snapshot(): TraceRunSnapshot {
    return {
      runId: this.runId,
      sessionId: this.sessionId,
      userId: this.userId,
      enterpriseId: this.enterpriseId,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      elapsedMs: Date.now() - this.startMs,
      model: this.model,
      context: this.contextDto,
      steps: this.steps,
      toolCalls: this.tools,
      provenance: this.provenanceRows,
      usage: this.usageDto,
      stepsTruncated: this.stepsTruncated,
      finalText: this.finalText,
      error: this.failure,
    };
  }
}
