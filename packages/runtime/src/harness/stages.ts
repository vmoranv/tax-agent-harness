/**
 * 单个回合的四个阶段。
 *
 * 拆分动机：原 `executeTurn` 约 120 行，混合了「装配 / 循环 / 溯源 / 回推」
 * 四件不同的事，测试时无法单独替换其中一段。
 *
 * 现在每段都是**纯函数 + 显式输入输出**：
 * - `recallStage`        读规则、记忆、偏好
 * - `assembleStage`      装配上下文并记录 trace
 * - `executeStage`       Agent 多步循环
 * - `provenanceStage`    数字溯源与兜底改写
 */

import type { RuleReference } from '@harness/contracts';
import type { EnterpriseId, Month, UserId } from '@harness/domain';
import { type AgentToolSpec, runAgentLoop } from '../agent/agent-loop.js';
import type { DeadlockCircuitBreaker } from '../ambiguity/index.js';
import {
  type AssembledContext,
  assembleContext,
  type MemoryLine,
  type RuleLine,
} from '../context/index.js';
import { log } from '../log/index.js';
import { type LiteralEntry, stripUnsourced, verifyProvenance } from '../provenance/index.js';
import { collectMoneyLiterals } from '../tools/index.js';
import type { TraceRun } from '../trace/index.js';

/* ---------------------------- 阶段 1：召回 ---------------------------- */

export interface RecallInput {
  readonly userId: UserId;
  readonly enterpriseId: EnterpriseId;
  readonly month: Month;
  readonly loadRules: (e: EnterpriseId, m: Month) => Promise<readonly RuleReference[]>;
  readonly loadMemory: (u: UserId, e: EnterpriseId) => Promise<MemoryLine | null>;
  readonly loadPreferences: (
    u: UserId,
    e: EnterpriseId,
  ) => Promise<ReadonlyArray<{ key: string; value: string }>>;
}

export interface RecallOutput {
  readonly rules: readonly RuleReference[];
  readonly memory: MemoryLine | null;
  readonly preferences: ReadonlyArray<{ key: string; value: string }>;
}

export async function recallStage(input: RecallInput): Promise<RecallOutput> {
  const [rules, memory, preferences] = await Promise.all([
    input.loadRules(input.enterpriseId, input.month),
    input.loadMemory(input.userId, input.enterpriseId),
    input.loadPreferences(input.userId, input.enterpriseId),
  ]);
  return { rules, memory, preferences };
}

/* ---------------------------- 阶段 2：装配 ---------------------------- */

export interface AssembleInputStage {
  readonly recalled: RecallOutput;
  readonly enterpriseName: string;
  readonly accessLevel: 'read-write' | 'read-only' | 'none';
  readonly history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  readonly toolNames: readonly string[];
  readonly budgetTokens: number;
  readonly userId: string;
  readonly enterpriseId: string;
}

export function assembleStage(input: AssembleInputStage): AssembledContext & {
  readonly ruleLines: readonly RuleLine[];
} {
  const ruleLines: RuleLine[] = input.recalled.rules.map((r) => ({
    code: r.code,
    title: r.title,
    version: r.version,
    obligationSummary: summarizeRule(r),
  }));

  const ctx = assembleContext(
    {
      enterpriseName: input.enterpriseName,
      accessLevel: input.accessLevel,
      rules: ruleLines,
      memory: input.recalled.memory,
      preferences: input.recalled.preferences,
      taskCardSummary: null,
      history: input.history,
      budget: { maxTokens: input.budgetTokens },
    },
    input.toolNames,
  );

  return { ...ctx, ruleLines };
}

/** 把规则转成一句人话，供 instructions 使用。 */
export function summarizeRule(r: RuleReference): string {
  if (r.summary && r.summary.trim() !== '') {
    return r.summary;
  }
  return `${r.title} (${r.scope}，生效于 ${r.effectiveFrom})`;
}

/* ---------------------------- 阶段 3：执行 ---------------------------- */

export interface ExecuteStageInput {
  readonly model: Parameters<typeof runAgentLoop>[0]['model'];
  readonly instructions: string;
  readonly history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  readonly userText: string;
  readonly tools: readonly AgentToolSpec[];
  readonly maxSteps: number;
  readonly toolContext: {
    readonly runId: string;
    readonly userId: string;
    readonly enterpriseId: string;
  };
  readonly trace: TraceRun;
  readonly circuitBreaker?: DeadlockCircuitBreaker;
  readonly onToolResult?: (name: string, ok: boolean) => void;
}

export interface ExecuteStageOutput {
  readonly text: string;
  readonly truncated: boolean;
  readonly toolCallCount: number;
  readonly ledger: readonly LiteralEntry[];
}

export async function executeStage(input: ExecuteStageInput): Promise<ExecuteStageOutput> {
  const ledger: LiteralEntry[] = [];

  const loop = await runAgentLoop({
    model: input.model,
    instructions: input.instructions,
    messages: [...input.history, { role: 'user', content: input.userText }],
    tools: input.tools,
    maxSteps: input.maxSteps,
    toolContext: { ...input.toolContext, toolCallId: 'pending' },
    onToolResult: ({ id, name, args, result, elapsedMs }) => {
      if (input.circuitBreaker) {
        const check = input.circuitBreaker.checkAndRecord(name, args);
        if (check.tripped) {
          log.warn('死锁熔断器触发：拦截连续重复调用', { name, reason: check.reason });
        }
      }
      log.info('工具执行', { name, ok: result.ok, elapsedMs });
      input.trace.addToolCall({
        id,
        name,
        args,
        ok: result.ok,
        result: result.ok ? result.data : result.error,
        elapsedMs,
        ...(result.ok ? {} : { errorCode: result.error.code }),
      });
      if (result.ok) ledger.push(...collectMoneyLiterals(name, result.data));
      input.onToolResult?.(name, result.ok);
    },
  });

  return {
    text: loop.text,
    truncated: loop.truncated,
    toolCallCount: loop.steps.reduce((n, s) => n + s.toolCalls.length, 0),
    ledger,
  };
}

/* ---------------------------- 阶段 4：溯源 ---------------------------- */

export interface ProvenanceStageInput {
  readonly text: string;
  readonly ledger: readonly LiteralEntry[];
  readonly truncated: boolean;
  readonly trace: TraceRun;
}

export function provenanceStage(input: ProvenanceStageInput): string {
  const checks = verifyProvenance(input.text, input.ledger);
  input.trace.setProvenance(
    checks.map((c) => ({ literal: c.literal, source: c.source, ok: c.ok })),
  );

  const unsourced = checks.filter((c) => !c.ok);
  let text = input.text;

  if (unsourced.length > 0) {
    log.warn('回复含未溯源金额', { literals: unsourced.map((c) => c.literal) });
    text = stripUnsourced(input.text, checks);
  }

  if (input.truncated) {
    text =
      text.trim() === ''
        ? '这一轮没能得出完整结论。已完成的操作都记录在运行记录里，可以换个说法再试。'
        : `${text}\n\n（这一轮达到了处理步数上限，可能还有没做完的部分。）`;
  }

  input.trace.setFinalText(text);
  return text;
}
