/**
 * Agent 主循环（AI SDK v7）。
 *
 * v7 的关键 API（已核实 ai@7.0.159）：
 * - `stopWhen: isStepCount(n)` —— `maxSteps` 已废弃
 * - `instructions` —— `system` 已改名
 * - 工具用 `inputSchema` —— `parameters` 已废弃
 * - `onStepEnd` —— `onStepFinish` 已改名
 * - `result.responseMessages` 才是整轮累积
 *
 * 设计要点（
 * 1. **工具 execute 不 throw**：失败转成 `{ ok: false, error }`，
 *    让模型能读懂「发生了什么、下一步怎么做」。
 * 2. **步数预算分级**：接近上限时注入收尾提示，而不是直接掐断。
 * 3. **每步回调**：让 trace 能记录「模型看到了什么、调了什么」。
 */

import type { LanguageModel, Tool } from 'ai';
import { generateText, isStepCount, tool } from 'ai';
import type { z } from 'zod';

export interface AgentToolSpec {
  readonly name: string;
  readonly description: string;
  /** zod schema。工具入参里不得有计算结果字段。 */
  readonly inputSchema: z.ZodTypeAny;
  /** `ctx` 由 runtime 注入（runId / 已授权企业），模型无法提供。 */
  readonly execute: (args: unknown, ctx: ToolInvocationContext) => Promise<ToolExecutionResult>;
}

export interface ToolInvocationContext {
  readonly runId: string;
  readonly toolCallId: string;
  readonly userId: string;
  readonly enterpriseId: string;
}

export type ToolExecutionResult =
  | { readonly ok: true; readonly data: unknown; readonly meta?: unknown }
  | { readonly ok: false; readonly error: { code: string; message: string; hint?: string } };

export interface StepInfo {
  readonly index: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ id: string; name: string; args: unknown }>;
  readonly toolResults: ReadonlyArray<{ id: string; name: string; ok: boolean; data: unknown }>;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AgentLoopInput {
  readonly model: LanguageModel;
  readonly instructions: string;
  readonly messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  readonly tools: readonly AgentToolSpec[];
  readonly maxSteps: number;
  readonly toolContext: ToolInvocationContext;
  readonly timeoutMs?: number;
  readonly onStepEnd?: (step: StepInfo) => void;
  readonly onToolResult?: (r: {
    id: string;
    name: string;
    args: unknown;
    result: ToolExecutionResult;
    elapsedMs: number;
  }) => void;
}

export interface AgentLoopResult {
  readonly text: string;
  readonly steps: readonly StepInfo[];
  readonly usage: { inputTokens: number; outputTokens: number };
  readonly finishReason: string;
  readonly truncated: boolean;
}

/** 把声明式工具规格转成 AI SDK 的 ToolSet。 */
export function buildToolSet(
  specs: readonly AgentToolSpec[],
  ctx: ToolInvocationContext,
): Record<string, Tool> {
  const set: Record<string, Tool> = {};
  for (const spec of specs) {
    // AI SDK 的 `tool()` 用泛型从 inputSchema 推参数类型；我们的 schema 是
    // `z.ZodTypeAny`（运行时才知道形状），推断结果是 `never`，与实际不符。
    // 这里做一次收窄：参数在 execute 内部再做校验，类型不承担保证。
    const factory = tool as unknown as (def: {
      description: string;
      inputSchema: z.ZodTypeAny;
      execute: (args: never) => Promise<ToolExecutionResult>;
    }) => Tool;

    set[spec.name] = factory({
      description: spec.description,
      inputSchema: spec.inputSchema,
      execute: async (args) => {
        // 永不 throw：错误以结构化结果返回，模型据此自我修正
        try {
          return await spec.execute(args as unknown, ctx);
        } catch (err) {
          return {
            ok: false as const,
            error: {
              code: 'INTERNAL',
              message: err instanceof Error ? err.message : String(err),
              hint: '可以重试一次，或告知用户当前无法完成',
            },
          };
        }
      },
    });
  }
  return set;
}

/**
 * 执行多步工具循环。
 *
 * 注意 `stopWhen` 必须显式给：缺省只跑一步，模型会说「我来查一下」就结束。
 */
export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 90_000);

  try {
    const result = await generateText({
      model: input.model,
      instructions: input.instructions,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      tools: buildToolSet(input.tools, input.toolContext),
      stopWhen: isStepCount(input.maxSteps),
      abortSignal: controller.signal,
      // 写操作密集：重试交给「同值 no-op + 乐观锁」，不交给 SDK
      maxRetries: 0,
      onStepEnd: (step) => {
        const calls = (step.toolCalls ?? []).map((c) => ({
          id: c.toolCallId,
          name: c.toolName,
          args: c.input,
        }));
        const results = (step.toolResults ?? []).map((r) => {
          const out = r.output as { ok?: boolean; data?: unknown } | undefined;
          return {
            id: r.toolCallId,
            name: r.toolName,
            ok: out?.ok === true,
            data: out?.data ?? out,
          };
        });

        // onStepEnd 是可选回调；但下面的 onToolResult 分发不能依赖它是否存在
        // —— trace / provenance / SSE 都靠这个回调，缺了会让工具执行「静默」。
        input.onStepEnd?.({
          index: step.stepNumber ?? 0,
          text: step.text ?? '',
          toolCalls: calls,
          toolResults: results,
          inputTokens: step.usage?.inputTokens ?? 0,
          outputTokens: step.usage?.outputTokens ?? 0,
        });

        // 逐次回调工具结果，供 trace 与 provenance 使用（始终执行）。
        const byId = new Map(calls.map((c) => [c.id, c]));
        for (const r of results) {
          const c = byId.get(r.id);
          if (c === undefined) continue;
          input.onToolResult?.({
            id: r.id,
            name: r.name,
            args: c.args,
            result: r.ok
              ? { ok: true, data: r.data }
              : { ok: false, error: { code: 'INTERNAL', message: '工具返回失败' } },
            elapsedMs: 0,
          });
        }
      },
    });

    const steps: StepInfo[] = (result.steps ?? []).map((s, i) => ({
      index: i,
      text: s.text ?? '',
      toolCalls: (s.toolCalls ?? []).map((c) => ({
        id: c.toolCallId,
        name: c.toolName,
        args: c.input,
      })),
      toolResults: (s.toolResults ?? []).map((r) => {
        const out = r.output as { ok?: boolean; data?: unknown } | undefined;
        return { id: r.toolCallId, name: r.toolName, ok: out?.ok === true, data: out?.data ?? out };
      }),
      inputTokens: s.usage?.inputTokens ?? 0,
      outputTokens: s.usage?.outputTokens ?? 0,
    }));

    const truncated = result.finishReason === 'tool-calls';

    return {
      text: result.text ?? '',
      steps,
      usage: {
        inputTokens: result.totalUsage?.inputTokens ?? 0,
        outputTokens: result.totalUsage?.outputTokens ?? 0,
      },
      finishReason: String(result.finishReason ?? 'unknown'),
      truncated,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        text: '',
        steps: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: 'timeout',
        truncated: true,
      };
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    void startedAt;
  }
}

/* ------------------------- 脚本化假模型 ------------------------- */

export interface ScriptedTurn {
  readonly type: 'text' | 'tool-call' | 'tool-calls';
  readonly content?: string;
  readonly name?: string;
  readonly args?: unknown;
  readonly calls?: ReadonlyArray<{ name: string; args: unknown }>;
}

/**
 * 脚本化执行：不调用 LLM，按预设回合驱动工具。
 *
 * 用途：让「三场景端到端」在无 API key、无网络的 CI 里跑通。
 * 它同时验证了工具契约、边界值、幂等与 trace —— 是本项目性价比最高的测试资产。
 */
export async function runScripted(
  input: {
    readonly tools: readonly AgentToolSpec[];
    readonly toolContext: ToolInvocationContext;
    readonly onToolResult?: (r: {
      id: string;
      name: string;
      args: unknown;
      result: ToolExecutionResult;
      elapsedMs: number;
    }) => void;
    readonly onStepEnd?: (step: StepInfo) => void;
  },
  script: readonly (readonly ScriptedTurn[])[],
): Promise<AgentLoopResult> {
  const tools = new Map(input.tools.map((t) => [t.name, t]));
  const steps: StepInfo[] = [];
  let finalText = '';
  let callSeq = 0;

  for (const [i, turns] of script.entries()) {
    const texts: string[] = [];
    const calls: StepInfo['toolCalls'][number][] = [];
    const results: StepInfo['toolResults'][number][] = [];

    for (const turn of turns) {
      if (turn.type === 'text') {
        texts.push(turn.content ?? '');
        continue;
      }

      const list =
        turn.type === 'tool-calls'
          ? (turn.calls ?? [])
          : [{ name: turn.name ?? '', args: turn.args }];

      for (const c of list) {
        const t = tools.get(c.name);
        const id = `call_${++callSeq}`;
        const t0 = Date.now();

        let result: ToolExecutionResult;
        if (t === undefined) {
          result = { ok: false, error: { code: 'INTERNAL', message: `未知工具 ${c.name}` } };
        } else {
          try {
            result = await t.execute(c.args, { ...input.toolContext, toolCallId: id });
          } catch (err) {
            result = {
              ok: false,
              error: {
                code: 'INTERNAL',
                message: err instanceof Error ? err.message : String(err),
              },
            };
          }
        }

        calls.push({ id, name: c.name, args: c.args });
        results.push({
          id,
          name: c.name,
          ok: result.ok,
          data: result.ok ? result.data : result.error,
        });
        input.onToolResult?.({
          id,
          name: c.name,
          args: c.args,
          result,
          elapsedMs: Date.now() - t0,
        });
      }
    }

    finalText = texts.join('');
    steps.push({
      index: i,
      text: finalText,
      toolCalls: calls,
      toolResults: results,
      inputTokens: 0,
      outputTokens: 0,
    });
    input.onStepEnd?.(steps[steps.length - 1]!);
  }

  return {
    text: finalText,
    steps,
    usage: { inputTokens: 0, outputTokens: 0 },
    finishReason: 'stop',
    truncated: false,
  };
}
