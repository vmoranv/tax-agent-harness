/** 最小复现：MockLanguageModelV3 发 tool-call，SDK 是否执行工具？ */
import { generateText, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';

let executed = 0;
const model = new MockLanguageModelV3({
  provider: 'scripted',
  modelId: 'm',
  doGenerate: async () => ({
    content: [
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'write_thing',
        input: { value: 'hello' },
      },
    ],
    finishReason: 'tool-calls',
    usage: {
      inputTokens: {
        total: 1,
        noCache: { total: 0, cacheRead: 0, cacheWrite: 0 },
        cacheRead: 0,
        cacheWrite: 0,
      },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  }),
});

const res = await generateText({
  model,
  instructions: 'test',
  tools: {
    write_thing: tool({
      description: 'write',
      inputSchema: z.object({ value: z.string() }),
      execute: async (args) => {
        executed += 1;
        return { ok: true, got: args };
      },
    }),
  },
  stopWhen: undefined,
  maxRetries: 0,
});

console.log('executed count:', executed);
console.log(
  'steps:',
  res.steps.length,
  '| toolCalls:',
  res.steps.flatMap((s) => s.toolCalls ?? []).length,
  '| toolResults:',
  res.steps.flatMap((s) => s.toolResults ?? []).length,
);
console.log('toolResults:', JSON.stringify(res.steps.flatMap((s) => s.toolResults ?? [])));
