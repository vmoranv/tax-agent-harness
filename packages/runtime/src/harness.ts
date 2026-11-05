/**
 * Harness：一轮对话的编排器。
 *
 * 本项目**只有这一个入口** —— CLI、Web、IM 都通过它。
 * 三个场景（查、改、检查）走同一条路径，没有意图路由。
 *
 * 职责收窄说明（工业级重构）：
 * 原 `handle` + `executeTurn` 共约 200 行，混合了装配、循环、溯源、回推。
 * 现在只做**编排**，四段逻辑各自独立在 `harness/stages.ts`，可单独测试。
 */

import type { RuleReference } from '@harness/contracts';
import type { EnterpriseId, Month, UserId } from '@harness/domain';
import { parseMonth, userId as toUserId } from '@harness/domain';
import type { LanguageModel } from 'ai';
import type { AgentToolSpec } from './agent/agent-loop.js';
import { DeadlockCircuitBreaker, InputNormalizer } from './ambiguity/index.js';
import type { MemoryLine } from './context/index.js';
import { assembleStage, executeStage, provenanceStage, recallStage } from './harness/stages.js';
import { log, withLogContext } from './log/index.js';
import type { MessageEvent, PlatformAdapter } from './platform/index.js';
import { type ApplicationFacade, createTools } from './tools/index.js';
import { TraceRun } from './trace/index.js';
import type { TraceSink } from './trace/sink.js';

export interface HarnessDeps {
  readonly app: ApplicationFacade;
  /**
   * 运行记录落盘端口。
   * 传 TraceStore（SQLite 同步）或 PgTraceSink（异步）都行 —— Harness 不再关心具体存储。
   */
  readonly traceSink: TraceSink;
  readonly createModel: () => LanguageModel;
  readonly modelId: string;
  readonly providerId: string;
  readonly loadRules: (e: EnterpriseId, m: Month) => Promise<readonly RuleReference[]>;
  readonly loadMemory: (u: UserId, e: EnterpriseId) => Promise<MemoryLine | null>;
  readonly loadPreferences: (
    u: UserId,
    e: EnterpriseId,
  ) => Promise<ReadonlyArray<{ key: string; value: string }>>;
  /**
   * 会话历史读写端口（可选）。未提供时退化为「无历史」，不影响单轮能力。
   * 必须读写同一个 sessionKey，否则多轮上下文会断。
   */
  readonly session?: {
    readonly history: (
      sessionKey: string,
      limit: number,
    ) => Promise<ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>>;
    readonly append: (
      sessionKey: string,
      role: 'user' | 'assistant',
      content: string,
    ) => Promise<void>;
  };
  /**
   * 模型选择（可选）。传入时优先于 `createModel`。
   * 演示模式用它注入脚本化模型，使脚本同样走完整 Harness 链路（trace / 会话 / 任务卡）。
   */
  readonly modelFor?: (event: MessageEvent) => LanguageModel | null;
  readonly maxSteps?: number;
  readonly budgetTokens?: number;
  /** 当前月份来源，测试可注入固定值。 */
  readonly now?: () => Date;
  /**
   * 运行事件回调（SSE 推送的数据源）。
   * 与平台适配器解耦：platform.send 面向「当前会话」，onEvent 面向「运行观测」，
   * API 层用它把步骤事件广播给订阅同一 runId 的 SSE 连接。
   */
  readonly onEvent?: (e: RunEvent) => void;
}

export type RunEvent =
  | { readonly type: 'run.started'; readonly runId: string }
  | { readonly type: 'tool'; readonly runId: string; readonly name: string; readonly ok: boolean }
  | { readonly type: 'done'; readonly runId: string; readonly text: string }
  | { readonly type: 'error'; readonly runId: string; readonly message: string };

export interface TurnResult {
  readonly runId: string;
  readonly text: string;
  readonly degraded: boolean;
  readonly toolCallCount: number;
}

let runSeq = 0;

export class Harness {
  private readonly tools: readonly AgentToolSpec[];
  private readonly normalizer = new InputNormalizer();
  private readonly circuitBreaker = new DeadlockCircuitBreaker();

  constructor(private readonly deps: HarnessDeps) {
    this.tools = createTools({
      app: deps.app,
      nextToolCallId: () => `call_${++runSeq}`,
    });
  }

  /** 处理一轮对话 —— 全系统唯一入口。 */
  async handle(
    event: MessageEvent,
    platform: PlatformAdapter,
    opts: { runId?: string } = {},
  ): Promise<TurnResult> {
    const runId = opts.runId ?? `run_${Date.now().toString(36)}_${++runSeq}`;
    const trace = TraceRun.start({
      runId,
      providerId: this.deps.providerId,
      modelId: this.deps.modelId,
      sessionId: event.umo.toString(),
      userId: event.userId,
      enterpriseId: event.enterpriseId,
    });

    this.deps.onEvent?.({ type: 'run.started', runId });

    return withLogContext(
      { runId, userId: event.userId, enterpriseId: event.enterpriseId },
      async () => {
        log.info('本轮开始', {
          enterpriseId: event.enterpriseId,
          textLength: event.text.length,
        });
        try {
          const result = await this.orchestrate(runId, event, platform, trace);
          trace.finish();
          await this.deps.traceSink.save(trace.snapshot());
          log.info('本轮完成', {
            toolCallCount: result.toolCallCount,
            degraded: result.degraded,
          });
          this.deps.onEvent?.({ type: 'done', runId, text: result.text });
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error('本轮执行失败', err);
          trace.fail('INTERNAL', message);
          this.deps.onEvent?.({ type: 'error', runId, message });
          await this.deps.traceSink.save(trace.snapshot());
          await platform.send(event, { kind: 'error', message });
          return { runId, text: '', degraded: false, toolCallCount: 0 };
        }
      },
    );
  }

  /** 四段编排：召回 → 装配 → 执行 → 溯源。 */
  private async orchestrate(
    runId: string,
    event: MessageEvent,
    platform: PlatformAdapter,
    trace: TraceRun,
  ): Promise<TurnResult> {
    const now = this.deps.now?.() ?? new Date();
    const month = parseMonth(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);

    const recalled = await recallStage({
      userId: toUserId(event.userId),
      enterpriseId: event.enterpriseId as EnterpriseId,
      month,
      loadRules: this.deps.loadRules,
      loadMemory: this.deps.loadMemory,
      loadPreferences: this.deps.loadPreferences,
    });
    log.info('召回完成', {
      ruleCount: recalled.rules.length,
      hasMemory: recalled.memory !== null,
      preferenceCount: recalled.preferences.length,
    });

    // 多轮历史：优先使用会话仓储，其次退回事件里带的历史（IM 平台自带）
    const sessionKey = event.umo.toString();
    const persistedHistory =
      this.deps.session === undefined ? [] : await this.deps.session.history(sessionKey, 40);
    const eventHistory =
      event.getExtra<Array<{ role: 'user' | 'assistant'; content: string }>>('history') ?? [];
    const history = persistedHistory.length > 0 ? persistedHistory : eventHistory;

    const ctx = assembleStage({
      recalled,
      enterpriseName: event.getExtra<string>('enterpriseName') ?? event.enterpriseId,
      accessLevel:
        event.getExtra<'read-write' | 'read-only' | 'none'>('accessLevel') ?? 'read-only',
      history,
      toolNames: this.tools.map((t) => t.name),
      budgetTokens: this.deps.budgetTokens ?? 12_000,
      userId: event.userId,
      enterpriseId: event.enterpriseId,
    });
    log.info('上下文装配完成', {
      ruleCount: recalled.rules.length,
      historyMessages: ctx.history.length,
      estimatedTokens: ctx.estimatedTokens,
      degradeLevel: ctx.degradeLevel,
    });

    trace.setContext({
      instructions: ctx.instructions,
      instructionsHash: ctx.instructionsHash,
      userId: event.userId,
      enterpriseId: event.enterpriseId,
      accessLevel: 'read-write',
      memory: {
        taskCardId:
          recalled.memory === null
            ? null
            : `${recalled.memory.enterpriseName}/${recalled.memory.month}`,
        preferenceKeys: recalled.preferences.map((p) => p.key),
      },
      rules: recalled.rules,
      historyMessages: ctx.history.length,
      estimatedTokens: ctx.estimatedTokens,
      degradeLevel: ctx.degradeLevel,
    });

    // 第一层：输入规范化（术语标准化、指代消解、省略补全）
    const normalized = this.normalizer.normalize(event.text, {
      activeEnterprise: String(event.enterpriseId),
      activeMonth: recalled.memory?.month,
      recentInvoiceNos: recalled.memory?.pending,
      lastMentionedInvoiceNo: recalled.memory?.pending[0],
    });

    const userTextForModel = normalized.normalizedText;

    this.circuitBreaker.reset();

    const model = this.deps.modelFor?.(event) ?? this.deps.createModel();

    const executed = await executeStage({
      model,
      circuitBreaker: this.circuitBreaker,
      instructions: ctx.instructions,
      history: ctx.history,
      userText: userTextForModel,
      tools: this.tools,
      maxSteps: this.deps.maxSteps ?? 8,
      toolContext: {
        runId,
        userId: event.userId,
        enterpriseId: event.enterpriseId,
      },
      trace,
      onToolResult: (name, ok) => {
        void platform.send(event, { kind: 'tool', name, ok });
        this.deps.onEvent?.({ type: 'tool', runId, name, ok });
      },
    });
    log.info('模型/工具执行结束', {
      toolCallCount: executed.toolCallCount,
      truncated: executed.truncated,
      textLength: executed.text.length,
    });

    const finalText = provenanceStage({
      text: executed.text,
      ledger: executed.ledger,
      truncated: executed.truncated,
      trace,
    });

    // 持久化本轮对话（用户原话用原文，不用规范化后的文本）
    if (this.deps.session !== undefined) {
      await this.deps.session
        .append(sessionKey, 'user', event.text)
        .catch((e: unknown) => log.warn('会话历史写入失败（user）', { error: String(e) }));
      await this.deps.session
        .append(sessionKey, 'assistant', finalText)
        .catch((e: unknown) => log.warn('会话历史写入失败（assistant）', { error: String(e) }));
    }

    await platform.send(event, { kind: 'done', text: finalText });

    return {
      runId,
      text: finalText,
      degraded: ctx.degradeLevel !== 'L0',
      toolCallCount: executed.toolCallCount,
    };
  }
}
