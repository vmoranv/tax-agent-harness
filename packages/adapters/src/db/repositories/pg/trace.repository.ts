/**
 * 运行记录仓储（PostgreSQL）。
 *
 * 三步写入：run 头、steps、tool_calls。分表的好处是：
 * - 步骤可以增量写，不用整轮结束才落库
 * - 按 run 查询时只取需要的部分
 */

import { and, desc, eq } from 'drizzle-orm';
import type { PgDatabase } from '../../pg-client.js';
import { traceRun, traceStep, traceToolCall } from '../../schema/pg.schema.js';

export interface TraceRunRow {
  runId: string;
  conversationId: string | null;
  userId: string | null;
  enterpriseId: string | null;
  providerId: string;
  modelId: string;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number | null;
  instructions: string | null;
  instructionsHash: string | null;
  estimatedTokens: number | null;
  degradeLevel: string | null;
  finalText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface TraceStepRow {
  idx: number;
  kind: string;
  at: string;
  elapsedMs: number;
  payload: unknown;
}

export interface TraceToolCallRow {
  callId: string;
  name: string;
  args: unknown;
  ok: boolean;
  result: unknown;
  errorCode: string | null;
  elapsedMs: number;
}

export class PgTraceRepository {
  constructor(private readonly db: PgDatabase) {}

  async startRun(row: TraceRunRow): Promise<void> {
    await this.db.insert(traceRun).values({
      runId: row.runId,
      conversationId: row.conversationId,
      userId: row.userId,
      enterpriseId: row.enterpriseId,
      providerId: row.providerId,
      modelId: row.modelId,
      startedAt: new Date(row.startedAt),
      finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt),
      elapsedMs: row.elapsedMs,
      instructions: row.instructions,
      instructionsHash: row.instructionsHash,
      estimatedTokens: row.estimatedTokens,
      degradeLevel: row.degradeLevel,
      finalText: row.finalText,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
    });
  }

  async finishRun(
    runId: string,
    patch: Partial<
      Pick<
        TraceRunRow,
        | 'finishedAt'
        | 'elapsedMs'
        | 'finalText'
        | 'errorCode'
        | 'errorMessage'
        | 'instructions'
        | 'instructionsHash'
        | 'estimatedTokens'
        | 'degradeLevel'
      >
    >,
  ): Promise<void> {
    await this.db
      .update(traceRun)
      .set({
        ...(patch.finishedAt === undefined
          ? {}
          : { finishedAt: patch.finishedAt === null ? null : new Date(patch.finishedAt) }),
        ...(patch.elapsedMs === undefined ? {} : { elapsedMs: patch.elapsedMs }),
        ...(patch.finalText === undefined ? {} : { finalText: patch.finalText }),
        ...(patch.errorCode === undefined ? {} : { errorCode: patch.errorCode }),
        ...(patch.errorMessage === undefined ? {} : { errorMessage: patch.errorMessage }),
        ...(patch.instructions === undefined ? {} : { instructions: patch.instructions }),
        ...(patch.instructionsHash === undefined
          ? {}
          : { instructionsHash: patch.instructionsHash }),
        ...(patch.estimatedTokens === undefined ? {} : { estimatedTokens: patch.estimatedTokens }),
        ...(patch.degradeLevel === undefined ? {} : { degradeLevel: patch.degradeLevel }),
      })
      .where(eq(traceRun.runId, runId));
  }

  async appendStep(runId: string, step: TraceStepRow): Promise<void> {
    await this.db.insert(traceStep).values({
      runId,
      idx: step.idx,
      kind: step.kind,
      at: new Date(step.at),
      elapsedMs: step.elapsedMs,
      payload: step.payload,
    });
  }

  async appendToolCall(runId: string, call: TraceToolCallRow): Promise<void> {
    await this.db.insert(traceToolCall).values({
      runId,
      callId: call.callId,
      name: call.name,
      args: call.args,
      ok: call.ok,
      result: call.result,
      errorCode: call.errorCode,
      elapsedMs: call.elapsedMs,
    });
  }

  async get(runId: string): Promise<{
    run: TraceRunRow;
    steps: TraceStepRow[];
    toolCalls: TraceToolCallRow[];
  } | null> {
    const runs = await this.db.select().from(traceRun).where(eq(traceRun.runId, runId)).limit(1);
    const row = runs[0];
    if (row === undefined) return null;

    const steps = await this.db
      .select()
      .from(traceStep)
      .where(eq(traceStep.runId, runId))
      .orderBy(traceStep.idx);

    const calls = await this.db.select().from(traceToolCall).where(eq(traceToolCall.runId, runId));

    return {
      run: {
        runId: row.runId,
        conversationId: row.conversationId,
        userId: row.userId,
        enterpriseId: row.enterpriseId,
        providerId: row.providerId,
        modelId: row.modelId,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
        elapsedMs: row.elapsedMs,
        instructions: row.instructions,
        instructionsHash: row.instructionsHash,
        estimatedTokens: row.estimatedTokens,
        degradeLevel: row.degradeLevel,
        finalText: row.finalText,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
      },
      steps: steps.map((s) => ({
        idx: s.idx,
        kind: s.kind,
        at: s.at.toISOString(),
        elapsedMs: s.elapsedMs,
        payload: s.payload,
      })),
      toolCalls: calls.map((c) => ({
        callId: c.callId,
        name: c.name,
        args: c.args,
        ok: c.ok,
        result: c.result,
        errorCode: c.errorCode,
        elapsedMs: c.elapsedMs,
      })),
    };
  }

  async list(limit = 20, filter: { userId?: string } = {}): Promise<TraceRunRow[]> {
    const base = this.db.select().from(traceRun);
    const rows =
      filter.userId === undefined
        ? await base.orderBy(desc(traceRun.startedAt)).limit(limit)
        : await base
            .where(eq(traceRun.userId, filter.userId))
            .orderBy(desc(traceRun.startedAt))
            .limit(limit);

    return rows.map((row) => ({
      runId: row.runId,
      conversationId: row.conversationId,
      userId: row.userId,
      enterpriseId: row.enterpriseId,
      providerId: row.providerId,
      modelId: row.modelId,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      elapsedMs: row.elapsedMs,
      instructions: row.instructions,
      instructionsHash: row.instructionsHash,
      estimatedTokens: row.estimatedTokens,
      degradeLevel: row.degradeLevel,
      finalText: row.finalText,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
    }));
  }

  /** 进程崩溃留下的未完成 run —— 与 Harness 的 `_interrupt_inactive` 同义。 */
  async markInterrupted(): Promise<number> {
    const r = await this.db
      .update(traceRun)
      .set({ errorCode: 'INTERRUPTED', errorMessage: '进程中断，本轮未完成' })
      .where(and(eq(traceRun.errorCode, null as never)));
    return r.rowCount ?? 0;
  }
}
