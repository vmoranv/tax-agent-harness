/**
 * 在线语义链路演示入口（把预留的 scripted-model 注入机制接上）。
 *
 * 背景：Harness 的 `modelFor(event)`（`runtime-factory.ts`）支持在 MessageEvent 上
 * 挂 `script` extra 走 `createScriptedModel`，从而**不接真 LLM** 也能驱动完整在线链路
 * （recall → assemble → generateText 工具循环 → provenance → trace）。但此前没有任何
 * route 设置该 extra，机制一直闲置；`/api/chat/script` 与 `/api/chat/offline` 是旁路
 * （`runTurns` 直接调工具，不经过 Harness / 模型）。
 *
 * 本路由补齐这个入口，用于：
 * - 零成本验证在线语义链路骨架（脚本化模型代替真 LLM，链路其余部分完全真实）；
 * - 产出可回溯的 TraceRun 证据（本轮 instructions / 选用规则 / 工具调用 / 数字溯源）。
 *
 * 注意：脚本化模型是**确定性剧本**，验证的是链路骨架，不是「模型语义理解」。
 * 真正的语义理解（换措辞 / 同句不同上下文 / 多轮补充）须接真 HARNESS_LLM_* 走
 * `/api/chat`（见 tools/demo/online-semantic.mjs --live）。
 */

import { enterpriseId, userId } from '@harness/domain';
import { MessageEvent, Umo } from '@harness/runtime';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Runtime } from '../runtime-factory.js';

const MAX_TEXT_LENGTH = 4000;

const ScriptTurnSchema = z.union([
  z.object({
    type: z.literal('tool-call'),
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('text'),
    content: z.string(),
  }),
]);

const DemoBody = z.object({
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  userId: z.string().regex(/^U\d{3}$/),
  enterpriseId: z.string().regex(/^C\d{3}$/),
  /** 剧本：外层每元素 = 模型一轮 doGenerate，内层 = 该轮 content。 */
  script: z.array(z.array(ScriptTurnSchema)).min(1),
  /** 写操作演示需要 read-write；默认 read-write。 */
  accessLevel: z.enum(['read-write', 'read-only']).optional(),
});

export async function demoRoutes(app: FastifyInstance): Promise<void> {
  app.post('/demo/semantic', async (req, reply) => {
    const parsed = DemoBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'VALIDATION_FAILED',
        details: parsed.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`),
      });
    }
    const { text, userId: uid, enterpriseId: eid, script, accessLevel } = parsed.data;
    const runtime = (app as unknown as { runtime: Runtime }).runtime;

    const event = new MessageEvent(Umo.of('api', 'http', `${uid}-${eid}`), {
      userId: userId(uid),
      enterpriseId: enterpriseId(eid),
      text,
      messageId: `demo_${Date.now()}`,
      receivedAt: new Date().toISOString(),
    });
    event.setExtra('enterpriseName', eid);
    event.setExtra('accessLevel', accessLevel ?? 'read-write');
    // 关键：挂上剧本，触发 modelFor → createScriptedModel，走完整 Harness 链路。
    // setExtra 接受 unknown，剧本已由 zod 校验过，无需强转。
    event.setExtra('script', script);

    try {
      const result = await runtime.harness.handle(event, runtime.platforms.get('api'));
      const snap = await runtime.traceSink.get(result.runId);
      const ctx = snap?.context ?? null;
      return reply.send({
        runId: result.runId,
        text: result.text,
        degraded: result.degraded,
        toolCallCount: result.toolCallCount,
        mode: 'scripted-semantic-chain',
        note: '脚本化模型驱动完整 Harness 链路（非真 LLM 语义理解）；模型输入/规则/工具/溯源见 evidence。',
        evidence: {
          model: snap?.model ?? null,
          contextInstructionsLength: ctx?.instructions?.length ?? 0,
          rules: ctx?.rules?.map((r) => `${r.code}@${r.version}`) ?? [],
          historyMessages: ctx?.historyMessages ?? 0,
          degradeLevel: ctx?.degradeLevel ?? null,
          toolCalls: snap?.toolCalls?.map((c) => ({ name: c.name, ok: c.ok, args: c.args })) ?? [],
          provenance: snap?.provenance ?? [],
          steps: snap?.steps?.map((s) => s.kind) ?? [],
          finalText: snap?.finalText ?? '',
          error: snap?.error ?? null,
        },
      });
    } catch (err) {
      return reply.status(500).send({
        error: 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
