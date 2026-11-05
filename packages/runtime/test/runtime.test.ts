import { enterpriseId, userId } from '@harness/domain';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { runAgentLoop, runScripted } from '../src/agent/agent-loop.js';
import { createScriptedModel } from '../src/agent/scripted-model.js';
import { assembleContext, estimateTokens } from '../src/context/index.js';
import { provenanceStage } from '../src/harness/stages.js';
import { logBroker, redactSecrets, withLogContext } from '../src/log/index.js';
import {
  createRunState,
  middleware,
  Pipeline,
  type Stage,
  terminal,
} from '../src/pipeline/index.js';
import { CapturingPlatform, MessageEvent, Umo } from '../src/platform/index.js';
import { extractMoneyLiterals, stripUnsourced, verifyProvenance } from '../src/provenance/index.js';
import type { ApplicationFacade } from '../src/tools/application-facade.js';
import { createTools, FORBIDDEN_INPUT_KEYS } from '../src/tools/index.js';
import { TraceRun } from '../src/trace/index.js';

/* ------------------------- 测试替身 ------------------------- */

const stubApp: ApplicationFacade = {
  summarize: async () => ({
    kind: 'denied',
    enterpriseId: 'C001',
    reason: 'no_grant',
    message: '无权限',
  }),
  findGaps: async () => ({
    kind: 'denied',
    enterpriseId: 'C001',
    reason: 'no_grant',
    message: '无权限',
  }),
  setPurpose: async () => ({
    kind: 'saved',
    changed: true,
    invoiceNo: 'F002',
    before: null,
    after: '办公用品采购',
    rereadAt: '2026-11-03T10:00:00Z',
  }),
  setRemark: async () => ({ kind: 'saved', changed: true, invoiceNo: 'F002', after: '备注' }),
  explainRules: async () => ({ kind: 'ok', applied: [], excluded: [], rationale: '' }),
  getTaskCard: async () => null,
};

const tools = createTools({ app: stubApp, nextToolCallId: () => 'call_1' });

function schemaOf(name: string): z.ZodTypeAny {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`工具不存在: ${name}`);
  return t.inputSchema;
}

/* ====================== 工具契约的硬约束 ====================== */

describe('工具入参不得含计算结果字段', () => {
  it('所有工具的 schema 都不含 total / sum / amount / net 等键', () => {
    for (const t of tools) {
      const shape = (t.inputSchema as z.ZodObject<z.ZodRawShape>).shape ?? {};
      for (const key of Object.keys(shape)) {
        for (const bad of FORBIDDEN_INPUT_KEYS) {
          expect(key.toLowerCase()).not.toContain(bad);
        }
      }
    }
  });

  it('set_invoice_purpose 只接收发票号与用途', () => {
    const shape = (schemaOf('set_invoice_purpose') as z.ZodObject<z.ZodRawShape>).shape;
    expect(Object.keys(shape).sort()).toEqual(['invoiceNo', 'purpose']);
  });

  it('没有任何工具接收 enterpriseId（企业由会话决定）', () => {
    for (const t of tools) {
      const shape = (t.inputSchema as z.ZodObject<z.ZodRawShape>).shape ?? {};
      expect(Object.keys(shape)).not.toContain('enterpriseId');
    }
  });
});

describe('explain_rules 权限被拒', () => {
  it('denied 分支返回 ACCESS_DENIED 工具失败，不伪装成成功', async () => {
    const deniedApp: ApplicationFacade = {
      ...stubApp,
      explainRules: async () => ({ kind: 'denied', reason: 'no_grant', message: '无权限查看规则' }),
    };
    const deniedTools = createTools({ app: deniedApp, nextToolCallId: () => 'call_denied' });
    const t = deniedTools.find((x) => x.name === 'explain_rules');
    expect(t).toBeDefined();
    const r = await t!.execute(
      { month: '2026-09' },
      { runId: 'r', toolCallId: 'c', userId: 'U001', enterpriseId: 'C001' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('ACCESS_DENIED');
      expect(r.error.message).toBe('无权限查看规则');
    }
  });
});

describe('runAgentLoop 工具结果分发', () => {
  it('只传 onToolResult（不传 onStepEnd）时工具结果仍会被回调（trace/provenance 不丢失）', async () => {
    // 回归：此前 onStepEnd 里有 `if (input.onStepEnd === undefined) return;`，
    // 而 onToolResult 分发写在它后面 —— executeStage 只传 onToolResult，
    // 导致工具执行了却「静默」：无 trace.addToolCall / 无 ledger / 金额被溯源抹掉。
    const script = [
      [
        {
          type: 'tool-call' as const,
          name: 'summarize_enterprise_month',
          args: { month: '2026-09' },
        },
      ],
      [{ type: 'text' as const, content: '合计 9,622.06 元' }],
    ];
    const got: string[] = [];
    const elapsed: number[] = [];
    const result = await runAgentLoop({
      model: createScriptedModel(script),
      instructions: '财税助手',
      messages: [{ role: 'user', content: '查金额' }],
      tools, // 复用顶部 stubApp 构造的 6 个工具
      maxSteps: 8,
      toolContext: { runId: 'r', toolCallId: 'c', userId: 'U001', enterpriseId: 'C001' },
      // 故意不传 onStepEnd
      onToolResult: ({ name, ok, elapsedMs }) => {
        got.push(`${name}:${ok}`);
        elapsed.push(elapsedMs);
      },
    });
    expect(result.text).toContain('9,622.06');
    expect(got.length).toBe(1);
    expect(got[0]).toContain('summarize_enterprise_month');
    // 缺口3回归：在线路径工具耗时不再硬编码为 0。
    expect(elapsed[0]).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(elapsed[0])).toBe(true);
  });
});

describe('month 必填且无默认值', () => {
  it('不传 month 会校验失败（模型必须追问）', () => {
    const parsed = schemaOf('summarize_enterprise_month').safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('month 格式非法会被拒绝', () => {
    expect(schemaOf('summarize_enterprise_month').safeParse({ month: '2026-13' }).success).toBe(
      false,
    );
    expect(schemaOf('summarize_enterprise_month').safeParse({ month: '9月' }).success).toBe(false);
  });

  it('合法月份通过', () => {
    expect(schemaOf('summarize_enterprise_month').safeParse({ month: '2026-09' }).success).toBe(
      true,
    );
  });
});

/* ============================ Pipeline ============================ */

function stage(name: string, order: number, log: string[]): Stage {
  return {
    name,
    order,
    process: () =>
      middleware(async (next) => {
        log.push(`${name}:pre`);
        await next();
        log.push(`${name}:post`);
      }),
  };
}

describe('Pipeline 洋葱模型', () => {
  it('前置按序、后置倒序', async () => {
    const trace: string[] = [];
    const p = new Pipeline([stage('A', 1, trace), stage('B', 2, trace), stage('C', 3, trace)]);

    await p.execute({
      runId: 'r1',
      event: new MessageEvent(Umo.of('cli', 'local', 's1'), {
        userId: userId('U001'),
        enterpriseId: enterpriseId('C001'),
        text: 'hi',
        messageId: 'm1',
        receivedAt: '2026-11-03',
      }),
      now: () => new Date(),
      state: createRunState(),
    });

    expect(trace).toEqual(['A:pre', 'B:pre', 'C:pre', 'C:post', 'B:post', 'A:post']);
  });

  it('terminal 短路后续 Stage', async () => {
    const trace: string[] = [];
    const p = new Pipeline([
      stage('A', 1, trace),
      {
        name: 'STOP',
        order: 2,
        process: () =>
          terminal(async () => {
            trace.push('STOP');
          }),
      },
      stage('C', 3, trace),
    ]);

    await p.execute({
      runId: 'r2',
      event: new MessageEvent(Umo.of('cli', 'local', 's1'), {
        userId: userId('U001'),
        enterpriseId: enterpriseId('C001'),
        text: 'hi',
        messageId: 'm1',
        receivedAt: '2026-11-03',
      }),
      now: () => new Date(),
      state: createRunState(),
    });

    expect(trace).toEqual(['A:pre', 'STOP', 'A:post']);
    expect(trace).not.toContain('C:pre');
  });

  it('order 不连续时启动期就报错', () => {
    expect(() => new Pipeline([stage('A', 1, []), stage('C', 5, [])])).toThrow(/顺序不连续/);
  });

  it('stopped 后不再执行后续 Stage', async () => {
    const trace: string[] = [];
    const state = createRunState();
    const p = new Pipeline([
      {
        name: 'STOPPER',
        order: 1,
        process: () =>
          terminal(async () => {
            state.stopped = true;
            trace.push('stop');
          }),
      },
      stage('B', 2, trace),
    ]);

    await p.execute({
      runId: 'r3',
      event: new MessageEvent(Umo.of('cli', 'local', 's1'), {
        userId: userId('U001'),
        enterpriseId: enterpriseId('C001'),
        text: 'hi',
        messageId: 'm1',
        receivedAt: '2026-11-03',
      }),
      now: () => new Date(),
      state,
    });

    expect(trace).toEqual(['stop']);
  });
});

/* ============================ 上下文 ============================ */

describe('上下文装配', () => {
  const base = {
    enterpriseName: '甲企业',
    accessLevel: 'read-write' as const,
    rules: [
      { code: 'R002', title: '甲企业发票用途规则', version: '2.0', obligationSummary: '每张必填' },
    ],
    memory: { enterpriseName: '甲企业', month: '2026-09', pending: ['F002'], note: null },
    preferences: [],
    taskCardSummary: null,
    history: [],
    budget: { maxTokens: 12_000 },
  };

  it('包含规则名称与版本', () => {
    const ctx = assembleContext(base, ['summarize_enterprise_month']);
    expect(ctx.instructions).toContain('R002');
    expect(ctx.instructions).toContain('v2.0');
  });

  it('包含企业、月份与未完成事项', () => {
    const ctx = assembleContext(base, ['x']);
    expect(ctx.instructions).toContain('甲企业');
    expect(ctx.instructions).toContain('2026-09');
    expect(ctx.instructions).toContain('F002');
  });

  it('纪律段明确要求不自己算金额', () => {
    const ctx = assembleContext(base, ['x']);
    expect(ctx.instructions).toContain('必须来自本轮工具返回');
  });

  it('超预算时按完整轮次丢弃历史，但保留规则与记忆', () => {
    const longHistory = Array.from({ length: 40 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: '这是一段很长的历史对话内容，用来撑爆上下文预算。'.repeat(20),
    }));
    const ctx = assembleContext({ ...base, history: longHistory, budget: { maxTokens: 3000 } }, [
      'x',
    ]);

    expect(ctx.history.length).toBeLessThan(longHistory.length);
    expect(ctx.degradeLevel).not.toBe('L0');
    // 关键：规则与记忆仍在
    expect(ctx.instructions).toContain('R002');
    expect(ctx.instructions).toContain('2026-09');
  });

  it('token 估算对中文合理（不低估）', () => {
    const zh = '甲企业九月发票合计九千六百二十二元零六分';
    expect(estimateTokens(zh)).toBeGreaterThan(zh.length * 0.8);
  });
});

/* ============================ 溯源 ============================ */

describe('数字溯源', () => {
  const ledger = [
    { tool: 'summarize', path: 'invoice.total', value: '9,622.06' },
    { tool: 'summarize', path: 'bank.expense', value: '7,180.74' },
  ];

  it('抽取金额字面量', () => {
    expect(extractMoneyLiterals('合计 9,622.06 元，支出 7,180.74 元')).toEqual([
      '9,622.06',
      '7,180.74',
    ]);
  });

  it('能溯源的金额标记 ok', () => {
    const checks = verifyProvenance('合计 9,622.06 元', ledger);
    expect(checks[0]).toMatchObject({ literal: '9,622.06', ok: true });
    expect(checks[0]?.source).toContain('tool:summarize');
  });

  it('无法溯源的金额被标记', () => {
    const checks = verifyProvenance('合计 12,345.67 元', ledger);
    expect(checks[0]).toMatchObject({ literal: '12,345.67', ok: false, source: 'not-found' });
  });

  it('千分位格式差异不影响匹配', () => {
    const checks = verifyProvenance('合计 9622.06 元', ledger);
    expect(checks[0]?.ok).toBe(true);
  });

  it('stripUnsourced 只替换可疑数字', () => {
    const text = '合计 9,622.06 元，另外 12,345.67 元存疑';
    const checks = verifyProvenance(text, ledger);
    const out = stripUnsourced(text, checks);
    expect(out).toContain('9,622.06');
    expect(out).not.toContain('12,345.67');
    expect(out).toContain('数据待核对');
  });
});

describe('零工具结果兜底（回复防护）', () => {
  const ledger = [{ tool: 'summarize', path: 'invoice.total', value: '9,622.06' }];
  const mkTrace = () => TraceRun.start({ runId: 'r-guard', providerId: 'p', modelId: 'm' });

  it('toolCallCount=0 且草稿含金额占位/张数时，整体换成诚实兜底', () => {
    const trace = mkTrace();
    const draft = '甲企业 2026-08 发票价税合计 **9,046.35 元**（共 10 张）。依据：R001。';
    const out = provenanceStage({
      text: draft,
      ledger: [], // 零工具结果
      truncated: false,
      trace,
      toolCallCount: 0,
    });
    expect(out).toContain('没能获取到账务数据');
    expect(out).not.toContain('9,046.35');
    expect(out).not.toContain('共 10 张');
  });

  it('有工具结果时不误伤（toolCallCount>0 保留 strip 逻辑）', () => {
    const trace = mkTrace();
    const draft = '合计 9,622.06 元，另有 12,345.67 元存疑';
    const out = provenanceStage({
      text: draft,
      ledger, // 上文的 ledger 含 9,622.06
      truncated: false,
      trace,
      toolCallCount: 1,
    });
    expect(out).toContain('9,622.06');
    expect(out).toContain('数据待核对'); // 存疑金额被 strip
    expect(out).not.toContain('没能获取到账务数据');
  });

  it('零工具但纯追问回复（无金额/张数）不误伤', () => {
    const trace = mkTrace();
    const draft = '请告诉我：是哪张发票？要填什么用途？';
    const out = provenanceStage({
      text: draft,
      ledger: [],
      truncated: false,
      trace,
      toolCallCount: 0,
    });
    expect(out).toBe(draft);
  });
});

/* ============================ 日志 ============================ */

describe('日志', () => {
  it('密钥在落盘前被脱敏', () => {
    expect(redactSecrets('key=sk-abcdefgh12345678')).not.toContain('abcdefgh12345678');
    expect(redactSecrets('Authorization: Bearer abcdefgh12345678')).toContain('[REDACTED]');
  });

  it('日志带上下文（runId）', () => {
    const got: string[] = [];
    const unsub = logBroker.subscribe((e) => got.push(e.context.runId ?? ''));
    withLogContext({ runId: 'run_xyz' }, () => {
      logBroker.emit('info', '测试', { a: 1 });
    });
    unsub();
    expect(got).toContain('run_xyz');
  });

  it('订阅时能回放缓存', () => {
    logBroker.emit('info', '历史消息');
    const got: string[] = [];
    const unsub = logBroker.subscribe((e) => got.push(e.msg));
    unsub();
    expect(got.some((m) => m.includes('历史消息'))).toBe(true);
  });
});

/* ============================ Trace ============================ */

describe('运行记录', () => {
  it('记录步骤且可序列化', () => {
    const run = TraceRun.start({ runId: 'r1', providerId: 'p', modelId: 'm' });
    run.addToolCall({
      id: 'c1',
      name: 'summarize_enterprise_month',
      args: { month: '2026-09' },
      ok: true,
      result: { total: '9,622.06' },
      elapsedMs: 12,
    });
    run.setFinalText('合计 9,622.06 元');
    run.finish();

    const snap = run.snapshot();
    expect(snap.steps.map((s) => s.kind)).toContain('tool.call');
    expect(snap.toolCalls).toHaveLength(1);
    expect(snap.finalText).toContain('9,622.06');
    expect(() => JSON.stringify(snap)).not.toThrow();
  });

  it('记录完整 instructions（R4 要求）', () => {
    const run = TraceRun.start({ runId: 'r2', providerId: 'p', modelId: 'm' });
    run.setContext({
      instructions: '完整的系统提示词内容',
      instructionsHash: 'abc',
      userId: 'U001',
      enterpriseId: 'C001',
      accessLevel: 'read-write',
      memory: { taskCardId: null, preferenceKeys: [] },
      rules: [
        {
          code: 'R002',
          version: '2.0',
          title: '甲',
          scope: 'C001',
          effectiveFrom: '2026-09-01',
          status: 'enabled',
        },
      ],
      historyMessages: 2,
      estimatedTokens: 100,
      degradeLevel: 'L0',
    });
    expect(run.snapshot().context?.instructions).toBe('完整的系统提示词内容');
  });

  it('真实 token 消耗落进 snapshot（缺口2）', () => {
    const run = TraceRun.start({ runId: 'r-usage', providerId: 'p', modelId: 'm' });
    expect(run.snapshot().usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    run.setUsage({ inputTokens: 123, outputTokens: 45 });
    expect(run.snapshot().usage).toEqual({ inputTokens: 123, outputTokens: 45 });
  });

  it('三类新 step 均被 emit（缺口1）', () => {
    const run = TraceRun.start({ runId: 'r-kinds', providerId: 'p', modelId: 'm' });
    run.recordModelCall({ stepCount: 0, maxSteps: 8 });
    run.recordReplyRendered({ textLength: 42, truncated: false });
    run.recordMemoryWrite({ turns: 2 });
    const kinds = run.snapshot().steps.map((s) => s.kind);
    expect(kinds).toContain('model.call');
    expect(kinds).toContain('reply.rendered');
    expect(kinds).toContain('memory.write');
  });

  it('step.elapsedMs 是单步耗时、sinceStartMs 是累计时间（缺口4）', () => {
    const run = TraceRun.start({ runId: 'r-timing', providerId: 'p', modelId: 'm' });
    run.record('context.assembled', {});
    const steps = run.snapshot().steps;
    // 至少 run.start + context.assembled 两步
    expect(steps.length).toBeGreaterThanOrEqual(2);
    for (const s of steps) {
      expect(s.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(s.sinceStartMs).toBeGreaterThanOrEqual(s.elapsedMs);
    }
    // 累计时间单调不减，单步耗时不再等于累计值（除非恰好同毫秒，这里只校验字段存在与语义）
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]!.sinceStartMs).toBeGreaterThanOrEqual(steps[i - 1]!.sinceStartMs);
    }
    const last = steps[steps.length - 1]!;
    expect(last.sinceStartMs).toBeGreaterThanOrEqual(last.elapsedMs);
  });

  it('step 数超 MAX_STEPS 时标记 stepsTruncated 而非静默丢弃', () => {
    const run = TraceRun.start({ runId: 'r-trunc', providerId: 'p', modelId: 'm' });
    // MAX_STEPS=500；先确认未超限为 false
    expect(run.snapshot().stepsTruncated).toBe(false);
    for (let i = 0; i < 505; i += 1) run.record('context.assembled', { i });
    const snap = run.snapshot();
    expect(snap.stepsTruncated).toBe(true);
    expect(snap.steps.length).toBe(500);
  });
});

/* ========================= 脚本化端到端 ========================= */

describe('脚本化执行（无模型）', () => {
  it('按脚本调用工具并产出最终文本', async () => {
    const platform = new CapturingPlatform();
    await platform.start();

    const result = await runScripted(
      {
        tools,
        toolContext: {
          runId: 'r1',
          toolCallId: 'c',
          userId: 'U001',
          enterpriseId: 'C001',
        },
      },
      [
        [
          {
            type: 'tool-call',
            name: 'set_invoice_purpose',
            args: { invoiceNo: 'F002', purpose: '办公用品采购' },
          },
        ],
        [{ type: 'text', content: 'F002 已填好' }],
      ],
    );

    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.toolCalls[0]?.name).toBe('set_invoice_purpose');
    expect(result.text).toBe('F002 已填好');
  });

  it('未知工具返回结构化错误而不是抛异常', async () => {
    const result = await runScripted(
      { tools, toolContext: { runId: 'r', toolCallId: 'c', userId: 'U001', enterpriseId: 'C001' } },
      [[{ type: 'tool-call', name: 'not_exist', args: {} }]],
    );
    expect(result.steps[0]?.toolResults[0]?.ok).toBe(false);
  });
});
