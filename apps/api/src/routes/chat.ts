/**
 * 对话接口。
 * - POST /api/chat        在线模式，调用真实 LLM 循环（无 LLM 时返回错误提示）
 * - POST /api/chat/script  演示模式，脚本驱动真实工具（无 LLM 依赖）
 *
 * 演示模式的核心区别：**不走 Harness Agent 循环，直接调工具**。
 * 但仍然写入 trace、会话历史，并触发任务卡推进（通过用例层）。
 * 这保证演示模式也能完整验证业务闭环。
 */

import {
  type Deps,
  findPurposeGaps,
  setInvoicePurpose,
  setInvoiceRemark,
  summarizeMonth,
} from '@harness/application';
import { enterpriseId, userId } from '@harness/domain';
import { log, MessageEvent, TraceRun, Umo, withLogContext } from '@harness/runtime';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Runtime } from '../runtime-factory.js';
import { routeOfflineIntent } from './offline-intent.js';

/** 对话文本最大长度（字符数），各输入 schema 共用。 */
const MAX_TEXT_LENGTH = 4000;
/** 离线演示 / 脚本工具未指定月份时使用的默认活跃税期。 */
const DEFAULT_MONTH = '2026-09';
/** 脚本演示写工具使用的固定 runId / toolCallId 占位值。 */
const DEMO_RUN_ID = 'demo';
/** runId 随机后缀：从 Math.random().toString(36) 截取的起止位置。 */
const RUN_ID_SUFFIX_START = 2;
const RUN_ID_SUFFIX_END = 6;

/** 请求体校验失败时统一的 400 响应体（收敛三个路由的重复样板）。 */
function validationError(error: z.core.$ZodError): { error: string; details: string[] } {
  return {
    error: 'VALIDATION_FAILED',
    details: error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`),
  };
}

/** 从 Fastify 实例取挂载的 Runtime（统一收敛重复强转）。 */
const runtimeOf = (app: FastifyInstance): Runtime =>
  (app as unknown as { runtime: Runtime }).runtime;

const BodySchema = z.object({
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  userId: z.string().regex(/^U\d{3}$/),
  enterpriseId: z.string().regex(/^C\d{3}$/),
  /**
   * 可选：显式会话标识。评测 runner 为每条用例传唯一值，避免多轮历史把
   * 过往轮次的答案喂给模型（data leakage）。不传时沿用 `${uid}-${eid}`
   * 的默认会话，保持线上正常多轮行为不变。
   */
  sessionId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
});

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

const ScriptBody = z.object({
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  userId: z.string().regex(/^U\d{3}$/),
  enterpriseId: z.string().regex(/^C\d{3}$/),
  turns: z.array(z.array(ScriptTurnSchema)).min(1),
});

const OfflineBody = z.object({
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  userId: z.string().regex(/^U\d{3}$/),
  enterpriseId: z.string().regex(/^C\d{3}$/),
});

type Turn =
  | { type: 'tool-call'; name: string; args: Record<string, unknown> }
  | { type: 'text'; content: string };

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post('/chat', async (req, reply) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(validationError(parsed.error));
    }

    const { text, userId: uid, enterpriseId: eid, sessionId } = parsed.data;
    const runtime = runtimeOf(app);

    // 显式 sessionId 优先（评测隔离）；否则沿用默认会话（线上多轮不变）。
    const umoSessionId = sessionId ?? `${uid}-${eid}`;
    const event = new MessageEvent(Umo.of('api', 'http', umoSessionId), {
      userId: userId(uid),
      enterpriseId: enterpriseId(eid),
      text,
      messageId: `m_${Date.now()}`,
      receivedAt: new Date().toISOString(),
    });

    try {
      const result = await runtime.harness.handle(event, runtime.platforms.get('api'));
      const detail = await readTrace(runtime, result.runId);
      return reply.send({
        runId: result.runId,
        text: result.text,
        degraded: result.degraded,
        toolCallCount: result.toolCallCount,
        steps: detail?.toolCalls ?? [],
        provenance: detail?.provenance ?? [],
      });
    } catch (err) {
      return reply.status(500).send({
        error: 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * 演示/离线模式：脚本驱动真实工具（不走 Agent 循环）。
   * 与在线模式一致，仍落一条完整 TraceRun 到 trace_run，保证运行记录可查。
   * 没有模型输入，因此不伪造 prompt：用 context.assembled 记录脚本本身。
   */
  app.post('/chat/script', async (req, reply) => {
    const parsed = ScriptBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(validationError(parsed.error));
    }
    const runtime = runtimeOf(app);
    const { userId: uid, enterpriseId: eid, turns } = parsed.data;
    return reply.send(await runTurns(runtime, uid, eid, turns as Turn[][], 'script'));
  });

  /**
   * 离线自由对话：把自然语言路由到真实工具用例（无 LLM 依赖）。
   * 与 /chat/script 共享执行与 trace 链路；识别不了时返回结构化澄清文本。
   */
  app.post('/chat/offline', async (req, reply) => {
    const parsed = OfflineBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(validationError(parsed.error));
    }
    const runtime = runtimeOf(app);
    const { text, userId: uid, enterpriseId: eid } = parsed.data;
    const routed = routeOfflineIntent(text, { enterpriseId: eid, defaultMonth: DEFAULT_MONTH });

    if (routed.kind === 'clarify') {
      return reply.send({
        runId: null,
        text: routed.message,
        toolCallCount: 0,
        steps: [],
        clarified: true,
      });
    }

    const result = await runTurns(runtime, uid, eid, routed.turns as Turn[][], 'offline');
    return reply.send({ ...result, clarified: false });
  });
}

interface RunTurnsResult {
  runId: string;
  text: string;
  toolCallCount: number;
  steps: Array<{ name: string; ok: boolean; data: unknown }>;
}

async function runTurns(
  runtime: Runtime,
  uid: string,
  eid: string,
  turns: Turn[][],
  mode: 'script' | 'offline',
): Promise<RunTurnsResult> {
  const appSvc = runtime.deps;
  const runId = `${mode}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(RUN_ID_SUFFIX_START, RUN_ID_SUFFIX_END)}`;

  const trace = TraceRun.start({
    runId,
    providerId: 'scripted',
    modelId: 'scripted-demo',
    sessionId: `api:http:${uid}-${eid}`,
    userId: uid,
    enterpriseId: eid,
  });

  const results: Array<{ name: string; ok: boolean; data: unknown }> = [];

  await withLogContext({ runId, userId: uid, enterpriseId: eid }, async () => {
    log.info('离线用例开始', {
      mode,
      toolCount: turns.flat().filter((t) => t.type === 'tool-call').length,
    });
    trace.record('context.assembled', { mode: `${mode}-demo`, turns });

    let seq = 0;
    for (const round of turns) {
      for (const turn of round) {
        if (turn.type !== 'tool-call') continue;
        seq += 1;
        const args = turn.args ?? {};
        const t0 = Date.now();
        try {
          const r = await executeTool(appSvc, uid, eid, turn.name, args);
          const elapsedMs = Date.now() - t0;
          results.push({ name: turn.name, ok: true, data: r });
          trace.addToolCall({
            id: `${runId}-tool-${seq}`,
            name: turn.name,
            args,
            ok: true,
            result: r,
            elapsedMs,
          });
          log.info('离线工具执行成功', { tool: turn.name, elapsedMs });
        } catch (err) {
          const elapsedMs = Date.now() - t0;
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ name: turn.name, ok: false, data: { error: msg } });
          trace.addToolCall({
            id: `${runId}-tool-${seq}`,
            name: turn.name,
            args,
            ok: false,
            result: { error: msg },
            elapsedMs,
            errorCode: 'SCRIPT_TOOL_FAILED',
          });
          log.error('离线工具执行失败', err, { tool: turn.name, elapsedMs });
        }
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    const finalText = okCount > 0 ? '演示完成' : '演示执行中出现错误';
    trace.setFinalText(finalText);
    if (okCount === 0) trace.fail('SCRIPT_FAILED', finalText);
    trace.finish();
    await runtime.traceSink.save(trace.snapshot());
    log.info('离线用例结束', { runId, okCount, failed: results.length - okCount });
  });

  return {
    runId,
    text: trace.snapshot().finalText,
    toolCallCount: results.filter((r) => r.ok).length,
    steps: results,
  };
}

async function executeTool(
  deps: Deps,
  uid: string,
  eid: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const actor = userId(uid);
  const entId = enterpriseId(eid);
  const month = typeof args['month'] === 'string' ? args['month'] : DEFAULT_MONTH;

  switch (name) {
    case 'summarize_enterprise_month': {
      const r = await summarizeMonth(deps, { actor, enterpriseId: entId, month: month as never });
      if (r.kind === 'ok') {
        return {
          enterprise: r.enterprise.shortName,
          month: r.month,
          invoice: { count: r.invoice.count, total: r.invoice.total.formatted },
          bank: {
            count: r.bank.count,
            expense: r.bank.expense.formatted,
            income: r.bank.income.formatted,
          },
          rules: r.applicableRules.map((x) => `${x.code} ${x.title} v${x.version}`),
        };
      }
      if (r.kind === 'empty')
        return { note: '该期间没有记录', invoice: { count: 0, total: '0.00' } };
      throw new Error(r.message);
    }
    case 'find_purpose_gaps': {
      const r = await findPurposeGaps(deps, { actor, enterpriseId: entId, month: month as never });
      if (r.kind === 'ok') {
        return {
          enterprise: r.enterprise.shortName,
          month: r.month,
          rule: `${r.rule.code} ${r.rule.title} v${r.rule.version}`,
          gaps: r.gaps.map((g) => ({
            invoiceNo: g.invoiceNo,
            amount: g.amount.formatted,
            reason: g.reason,
          })),
          optional: r.optional.map((g) => ({
            invoiceNo: g.invoiceNo,
            amount: g.amount.formatted,
            reason: g.reason,
          })),
          summary: `${r.gaps.length} 张必须填但未填，${r.optional.length} 张可按规则不填`,
        };
      }
      throw new Error(r.message);
    }
    case 'set_invoice_purpose': {
      const r = await setInvoicePurpose(deps, {
        actor,
        enterpriseId: entId,
        invoiceNo: String(args['invoiceNo'] ?? ''),
        newPurpose: String(args['purpose'] ?? ''),
        runId: DEMO_RUN_ID,
        toolCallId: DEMO_RUN_ID,
      });
      if (r.kind === 'saved')
        return {
          invoiceNo: r.invoiceNo,
          changed: r.changed,
          before: r.before,
          after: r.after,
          note: r.changed ? '已保存并重新查询确认' : '该发票已是这个内容',
        };
      throw new Error('message' in r ? String(r.message) : '写入失败');
    }
    case 'set_invoice_remark': {
      const r = await setInvoiceRemark(deps, {
        actor,
        enterpriseId: entId,
        invoiceNo: String(args['invoiceNo'] ?? ''),
        newRemark: String(args['remark'] ?? ''),
        runId: DEMO_RUN_ID,
        toolCallId: DEMO_RUN_ID,
      });
      if (r.kind === 'saved') return { invoiceNo: r.invoiceNo, changed: r.changed, after: r.after };
      throw new Error('message' in r ? String(r.message) : '写入失败');
    }
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

/** 复用 TraceSink 端口读取本轮 trace，去掉直接读 trace_run.payload 的第二条路径。 */
async function readTrace(
  runtime: Runtime,
  runId: string,
): Promise<{ toolCalls: readonly unknown[]; provenance: readonly unknown[] } | null> {
  const run = await runtime.traceSink.get(runId);
  if (run === null) return null;
  return { toolCalls: run.toolCalls ?? [], provenance: run.provenance ?? [] };
}
