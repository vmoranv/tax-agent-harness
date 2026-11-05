/**
 * 脚本化语言模型（供 `/api/chat/script` 演示与单测使用）。
 *
 * 与 `runScripted()` 的区别：
 * - `runScripted()` 绕过 Agent 循环，直接按剧本调工具 → **不产生 trace、不走 Harness**
 * - 本类实现 AI SDK 的 `LanguageModelV3`，由 `generateText` 驱动 → 走完整 Harness 链路
 *
 * 因此用它的 `chat/script` 能看到真实的 trace、会话历史写入、任务卡推进。
 *
 * 剧本格式与 `runScripted` 一致，便于两者共用 fixture：
 * ```
 * [[{ type:'tool-call', name:'summarize_enterprise_month', args:{month:'2026-09'} }],
 *  [{ type:'text', content:'...' }]]
 * ```
 */

import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

export interface ScriptTurn {
  readonly type: 'text' | 'tool-call';
  readonly content?: string;
  readonly name?: string;
  readonly args?: unknown;
}

export type Script = ReadonlyArray<ReadonlyArray<ScriptTurn>>;

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

/**
 * 把剧本编译成一个 `LanguageModel`。
 *
 * 每次 `doGenerate` 消费剧本的一轮；剧本耗尽后返回空文本终止，
 * 防止死循环（Harness 的步数预算也会兜底）。
 */
export function createScriptedModel(script: Script): LanguageModel {
  let cursor = 0;

  return new MockLanguageModelV3({
    provider: 'scripted',
    modelId: 'scripted-model',
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
      const round = script[cursor] ?? [];
      cursor += 1;

      const content: Array<Record<string, unknown>> = [];
      for (const [i, turn] of round.entries()) {
        if (turn.type === 'text') {
          content.push({ type: 'text', text: turn.content ?? '' });
        } else {
          content.push({
            type: 'tool-call',
            toolCallId: `call_${cursor}_${i}`,
            toolName: turn.name ?? '',
            // `input` 必须是 JSON 字符串 —— ai v7 会在 SDK 内部 `input.trim()`
            // 后自行 parse + zod 校验；传对象会报
            // `toolCall.input.trim is not a function`，工具被判 invalid 永不执行。
            input: JSON.stringify(turn.args ?? {}),
          });
        }
      }

      const hasToolCall = round.some((t) => t.type === 'tool-call');

      return {
        content: content as never,
        // ai v7 的 LanguageModelV3FinishReason 是对象 `{unified, raw}`，
        // 传字符串会让 SDK 读 `.unified` 得 undefined，工具执行被门禁拦截。
        finishReason: { unified: hasToolCall ? 'tool-calls' : 'stop', raw: undefined },
        usage: ZERO_USAGE as never,
        warnings: [],
      } as unknown as LanguageModelV3GenerateResult;
    },
  }) as unknown as LanguageModel;
}

/** 剧本跑完后如何表现。false = 返回空文本（Harness 会给出「无输出」兜底）。 */
export function isScriptExhausted(script: Script, round: number): boolean {
  return round >= script.length;
}
