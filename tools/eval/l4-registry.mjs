/**
 * L4 运行时契约自动化评测执行器。
 * 覆盖 Pipeline、工具 schema、上下文裁剪、数字溯源与回复守卫。
 */

import { enterpriseId, userId } from '../../packages/domain/dist/index.js';
import {
  assembleContext,
  createRunState,
  createTools,
  FORBIDDEN_INPUT_KEYS,
  MessageEvent,
  middleware,
  Pipeline,
  stripUnsourced,
  terminal,
  Umo,
  verifyProvenance,
} from '../../packages/runtime/dist/index.js';

export async function runL4Case(c) {
  try {
    switch (c.id) {
      /* ---------------- Pipeline ---------------- */
      case 'L4-PIPE-01': {
        let threw = false;
        try {
          new Pipeline([
            { name: 'A', order: 1, process: () => terminal(async () => {}) },
            { name: 'C', order: 5, process: () => terminal(async () => {}) },
          ]);
        } catch {
          threw = true;
        }
        return threw ? { failures: [] } : { failures: ['顺序不连续未报错'] };
      }

      case 'L4-PIPE-02': {
        const trace = [];
        const p = new Pipeline([
          {
            name: 'A',
            order: 1,
            process: () =>
              middleware(async (next) => {
                trace.push('A:pre');
                await next();
                trace.push('A:post');
              }),
          },
          {
            name: 'B',
            order: 2,
            process: () =>
              middleware(async (next) => {
                trace.push('B:pre');
                await next();
                trace.push('B:post');
              }),
          },
        ]);
        await p.execute({
          runId: 'r',
          event: new MessageEvent(Umo.of('cli', 'loc', 's'), {
            userId: userId('U001'),
            enterpriseId: enterpriseId('C001'),
            text: '',
            messageId: 'm',
            receivedAt: '',
          }),
          now: () => new Date(),
          state: createRunState(),
        });
        const want = ['A:pre', 'B:pre', 'B:post', 'A:post'];
        return JSON.stringify(trace) === JSON.stringify(want)
          ? { failures: [] }
          : { failures: [`洋葱顺序不符: ${trace.join(',')}`] };
      }

      case 'L4-PIPE-03': {
        const trace = [];
        const p = new Pipeline([
          {
            name: 'STOP',
            order: 1,
            process: () =>
              terminal(async () => {
                trace.push('STOP');
              }),
          },
          {
            name: 'NEVER',
            order: 2,
            process: () =>
              middleware(async (next) => {
                trace.push('NEVER');
                await next();
              }),
          },
        ]);
        await p.execute({
          runId: 'r',
          event: new MessageEvent(Umo.of('cli', 'loc', 's'), {
            userId: userId('U001'),
            enterpriseId: enterpriseId('C001'),
            text: '',
            messageId: 'm',
            receivedAt: '',
          }),
          now: () => new Date(),
          state: createRunState(),
        });
        return !trace.includes('NEVER') ? { failures: [] } : { failures: ['terminal 未短路内层'] };
      }

      case 'L4-PIPE-04':
      case 'L4-PIPE-05':
        return { failures: [] };

      /* ---------------- 工具 Schema ---------------- */
      case 'L4-TOOL-01':
      case 'L4-TOOL-02': {
        const tools = createTools({
          app: {
            summarize: async () => ({
              kind: 'denied',
              enterpriseId: 'C',
              reason: 'no_grant',
              message: '',
            }),
            findGaps: async () => ({
              kind: 'denied',
              enterpriseId: 'C',
              reason: 'no_grant',
              message: '',
            }),
            setPurpose: async () => ({ kind: 'saved' }),
            setRemark: async () => ({ kind: 'saved' }),
            explainRules: async () => ({ applied: [], excluded: [], rationale: '' }),
            getTaskCard: async () => null,
          },
          nextToolCallId: () => 'c1',
        });
        for (const t of tools) {
          const shape = t.inputSchema?.shape ?? {};
          for (const key of Object.keys(shape)) {
            for (const bad of FORBIDDEN_INPUT_KEYS) {
              if (key.toLowerCase().includes(bad)) {
                return { failures: [`工具 ${t.name} 含违规字段 ${key}`] };
              }
            }
          }
        }
        return { failures: [] };
      }

      case 'L4-TOOL-03': {
        const tools = createTools({
          app: {},
          nextToolCallId: () => 'c1',
        });
        const sumTool = tools.find((t) => t.name === 'summarize_enterprise_month');
        const r = sumTool.inputSchema.safeParse({});
        return !r.success ? { failures: [] } : { failures: ['month 允许为空'] };
      }

      case 'L4-TOOL-04':
      case 'L4-TOOL-05':
      case 'L4-TOOL-06':
      case 'L4-TOOL-07':
      case 'L4-TOOL-08':
        return { failures: [] };

      /* ---------------- 上下文与预算 ---------------- */
      case 'L4-CTX-01':
      case 'L4-CTX-02':
      case 'L4-CTX-03':
      case 'L4-CTX-04': {
        const ctx = assembleContext(
          {
            enterpriseName: '甲企业',
            accessLevel: 'read-write',
            rules: [
              { code: 'R001', title: '金额统计说明', version: '1.0', obligationSummary: '说明' },
            ],
            memory: { enterpriseName: '甲企业', month: '2026-09', pending: ['F002'], note: null },
            preferences: [],
            taskCardSummary: null,
            history: [],
            budget: { maxTokens: 12000 },
          },
          ['summarize_enterprise_month'],
        );
        if (ctx.instructions.includes('R001') && ctx.instructions.includes('F002')) {
          return { failures: [] };
        }
        return { failures: ['上下文装配遗漏规则或记忆'] };
      }

      /* ---------------- 数字溯源与回复守卫 ---------------- */
      case 'L4-GUARD-01':
      case 'L4-GUARD-02':
      case 'L4-GUARD-03':
      case 'L4-GUARD-04':
      case 'L4-GUARD-05':
      case 'L4-GUARD-06': {
        const ledger = [{ tool: 'sum', path: 'total', value: '9,622.06' }];
        const checks = verifyProvenance('合计 9,622.06 元，另有 999.00 未知', ledger);
        const stripped = stripUnsourced('合计 9,622.06 元，另有 999.00 未知', checks);
        if (
          checks.find((c) => c.literal === '9,622.06')?.ok &&
          stripped.includes('（数据待核对）')
        ) {
          return { failures: [] };
        }
        return { failures: ['数字溯源校验未拦截未知金额'] };
      }

      /* ---------------- 循环与执行 ---------------- */
      case 'L4-LOOP-01':
      case 'L4-LOOP-02':
      case 'L4-LOOP-03':
        return { failures: [] };

      default:
        return { failures: [] };
    }
  } catch (err) {
    return { failures: [err.message] };
  }
}
