/**
 * 工具集：**模型唯一能碰业务的入口**。
 *
 * 三条硬规则（对应 `01-architecture.md` 的 M1/M2/M3）：
 *
 * 1. **入参不含任何计算结果**。schema 里没有 `total` / `allowed` / `net`，
 *    模型想填也无处可填。金额只能由程序算出后返回。
 *
 * 2. **`month` 必填且无默认**。有默认值模型就永远不会追问，
 *    「缺月份要追问」这个评分点会静默失效。
 *
 * 3. **企业号不从模型传**。`enterpriseId` 标为可选但实际忽略，
 *    一律取 `ToolContext.enterpriseId`（已通过授权检查）。
 *    这样模型改一个参数也越不了权。
 */

import type { FindPurposeGapsResult, SummarizeMonthResult } from '@harness/contracts';
import { enterpriseId, Money, parseMonth, userId } from '@harness/domain';
import { z } from 'zod';
import type { AgentToolSpec, ToolExecutionResult } from '../agent/agent-loop.js';
import type { ApplicationFacade } from './application-facade.js';

export interface ToolContext {
  readonly runId: string;
  readonly toolCallId: string;
  readonly userId: string;
  /** 已通过授权检查的企业。工具不接受模型传来的企业号。 */
  readonly enterpriseId: string;
}

/** 工具执行期可变的部分：requestId 等由 runtime 生成，模型看不到。 */
export interface ToolRuntimeDeps {
  readonly app: ApplicationFacade;
  readonly nextToolCallId: () => string;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 月份 schema：**必填、无默认、无 optional**。
 *
 * 这是本项目最容易被写错的一个字段。若写成 `z.string().optional()`，
 * 模型永远不会追问「哪个月」，而工具会静默用当前月 —— 直接违反 R001-4。
 */
const monthSchema = z
  .string()
  .regex(MONTH_RE)
  .describe('月份，格式 YYYY-MM，例如 2026-09。必须由用户明确给出，不要猜测。');

function ok(data: unknown): ToolExecutionResult {
  return { ok: true, data };
}

function fail(code: string, message: string, hint?: string): ToolExecutionResult {
  return { ok: false, error: hint === undefined ? { code, message } : { code, message, hint } };
}

/* ============================ 工具定义 ============================ */

export function createTools(deps: ToolRuntimeDeps): readonly AgentToolSpec[] {
  return [
    /* ---------- 1. 月度汇总 ---------- */
    {
      name: 'summarize_enterprise_month',
      description:
        '统计某企业某月的发票价税合计、银行支出合计、银行收入合计，并返回本期适用的规则。' +
        '用户问金额、合计、收入、支出、总额时使用。' +
        '必须同时提供月份；缺月份会返回错误，此时应当追问用户，不要猜测。',
      inputSchema: z.object({ month: monthSchema }),
      execute: async (raw, ctx) => {
        const args = raw as { month?: string };
        if (!args?.month || typeof args.month !== 'string' || !MONTH_RE.test(args.month)) {
          return fail(
            'MISSING_PARAMETER',
            '缺少月份参数，请追问用户需要查询哪个月份（如 2026-09）',
          );
        }
        const r = await deps.app.summarize({
          actor: userId(ctx.userId),
          enterpriseId: enterpriseId(ctx.enterpriseId),
          month: parseMonth(args.month),
        });
        return mapSummary(r);
      },
    },

    /* ---------- 2. 缺项检查 ---------- */
    {
      name: 'find_purpose_gaps',
      description:
        '按本期适用的用途规则，列出某企业某月缺少用途的发票。' +
        '返回两组：gaps 是必须填但空着的，optional 是空着但规则允许的。' +
        '只有 gaps 里的才需要用户处理。用户问「哪些发票缺用途」时使用。',
      inputSchema: z.object({ month: monthSchema }),
      execute: async (raw, ctx) => {
        const args = raw as { month?: string };
        if (!args?.month || typeof args.month !== 'string' || !MONTH_RE.test(args.month)) {
          return fail(
            'MISSING_PARAMETER',
            '缺少月份参数，请追问用户需要查询哪个月份（如 2026-09）',
          );
        }
        const r = await deps.app.findGaps({
          actor: userId(ctx.userId),
          enterpriseId: enterpriseId(ctx.enterpriseId),
          month: parseMonth(args.month),
        });
        return mapGaps(r);
      },
    },

    /* ---------- 3. 修改用途 ---------- */
    {
      name: 'set_invoice_purpose',
      description:
        '把某张发票的「用途」设为指定内容。' +
        '只需要发票编号和用途文本；企业由当前会话确定，金额不可修改。' +
        '保存后会重新查询确认，返回旧值与新值。' +
        '同一内容重复提交不会产生第二次修改。',
      inputSchema: z.object({
        invoiceNo: z
          .string()
          .regex(/^F\d{3}$/)
          .describe('发票编号，例如 F002'),
        purpose: z.string().min(1).max(200).describe('要填入的用途文本'),
      }),
      execute: async (raw, ctx) => {
        const args = raw as { invoiceNo: string; purpose: string };
        const r = await deps.app.setPurpose({
          actor: userId(ctx.userId),
          enterpriseId: enterpriseId(ctx.enterpriseId),
          invoiceNo: args.invoiceNo,
          newPurpose: args.purpose,
          runId: ctx.runId,
          toolCallId: ctx.toolCallId,
        });
        return mapSetResult(r);
      },
    },

    /* ---------- 4. 修改备注 ---------- */
    {
      name: 'set_invoice_remark',
      description:
        '把某张发票的「备注」设为指定内容。备注不能代替用途。' + '保存后会重新查询确认。',
      inputSchema: z.object({
        invoiceNo: z
          .string()
          .regex(/^F\d{3}$/)
          .describe('发票编号，例如 F002'),
        remark: z.string().min(1).max(500).describe('要填入的备注文本'),
      }),
      execute: async (raw, ctx) => {
        const args = raw as { invoiceNo: string; remark: string };
        const r = await deps.app.setRemark({
          actor: userId(ctx.userId),
          enterpriseId: enterpriseId(ctx.enterpriseId),
          invoiceNo: args.invoiceNo,
          newRemark: args.remark,
          runId: ctx.runId,
          toolCallId: ctx.toolCallId,
        });
        return mapSetResult(r);
      },
    },

    /* ---------- 5. 规则说明 ---------- */
    {
      name: 'explain_rules',
      description:
        '说明某企业某月适用于哪些规则、排除了哪些规则以及排除原因。' +
        '用户问「依据是什么」「为什么用这个规则」时使用。',
      inputSchema: z.object({ month: monthSchema }),
      execute: async (raw, ctx) => {
        const args = raw as { month: string };
        const r = await deps.app.explainRules({
          actor: userId(ctx.userId),
          enterpriseId: enterpriseId(ctx.enterpriseId),
          month: parseMonth(args.month),
        });
        // 权限被拒必须作为工具失败返回，不能伪装成 ok 让模型拿到缺字段对象。
        if (r.kind === 'denied') {
          return fail('ACCESS_DENIED', r.message);
        }
        return ok(r);
      },
    },

    /* ---------- 6. 读任务卡 ---------- */
    {
      name: 'get_task_card',
      description:
        '读取当前用户在当前企业未完成的任务进度（企业、月份、剩余待办）。' +
        '用户问「刚才那个任务到哪了」「还剩哪些」时使用。',
      inputSchema: z.object({}),
      execute: async (_raw, ctx) => {
        const r = await deps.app.getTaskCard({
          actor: userId(ctx.userId),
          enterpriseId: enterpriseId(ctx.enterpriseId),
        });
        return ok(r);
      },
    },
  ];
}

/* ============================ 结果映射 ============================ */

function mapSummary(r: SummarizeMonthResult): ToolExecutionResult {
  switch (r.kind) {
    case 'ok':
      return ok({
        enterprise: r.enterprise.shortName,
        month: r.month,
        invoice: { count: r.invoice.count, total: r.invoice.total.formatted },
        bank: {
          count: r.bank.count,
          expense: r.bank.expense.formatted,
          income: r.bank.income.formatted,
        },
        rules: r.applicableRules.map((x) => `${x.code} ${x.title} v${x.version}`),
      });
    case 'empty':
      return ok({
        enterprise: r.enterprise.shortName,
        month: r.month,
        note: '该期间没有记录',
        invoice: { count: 0, total: '0.00' },
        bank: { count: 0, expense: '0.00', income: '0.00' },
      });
    case 'denied':
      // 关键：无权限返回 ACCESS_DENIED，绝不返回 0.00
      return fail('ACCESS_DENIED', r.message, '明确告诉用户没有权限，不要说没有记录');
  }
}

function mapGaps(r: FindPurposeGapsResult): ToolExecutionResult {
  switch (r.kind) {
    case 'ok':
      return ok({
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
      });
    case 'no-rule':
      return ok({
        enterprise: r.enterprise.shortName,
        month: r.month,
        note: r.message,
        gaps: [],
        optional: [],
      });
    case 'denied':
      return fail('ACCESS_DENIED', r.message, '明确告诉用户没有权限');
  }
}

interface SetOutcome {
  readonly kind: string;
  readonly changed?: boolean;
  readonly invoiceNo?: string;
  readonly before?: string | null;
  readonly after?: string | null;
  readonly rereadAt?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly field?: string;
  readonly currentVersion?: number;
  readonly expected?: string | null;
  readonly actual?: string | null;
  readonly invoiceId?: string;
}

function mapSetResult(r: SetOutcome): ToolExecutionResult {
  switch (r.kind) {
    case 'saved':
      return ok({
        invoiceNo: r.invoiceNo,
        changed: r.changed,
        before: r.before ?? '（空）',
        after: r.after,
        rereadAt: r.rereadAt,
        note: r.changed === false ? '该发票已是这个内容，未做修改' : '已保存并重新查询确认',
      });
    case 'denied':
      return fail('ACCESS_DENIED', r.message ?? '无权限', '明确告诉用户没有权限');
    case 'not-found':
      return fail('ENTITY_NOT_FOUND', `没有找到发票 ${r.invoiceId ?? ''}`, '请用户确认编号');
    case 'invalid':
      return fail('VALIDATION_FAILED', r.message ?? '内容不合法', '说明哪个字段为什么不行');
    case 'conflict':
      return fail('CONFLICT', '该发票刚被其他人修改过', '重新查询后再试');
    case 'verify-failed':
      return fail(
        'VERIFY_MISMATCH',
        `保存后核对不一致：期望「${r.expected ?? ''}」，实际「${r.actual ?? '（空）'}」`,
        '如实告知用户未能确认保存成功',
      );
    default:
      return fail('INTERNAL', '未知结果');
  }
}

/** 供测试断言：工具 schema 里不得出现计算字段。 */
export const FORBIDDEN_INPUT_KEYS = [
  'total',
  'sum',
  'amount',
  'allowed',
  'compliant',
  'net',
  'balance',
] as const;

/** 供 provenance 使用：把工具结果里的金额抽成字面量账本。 */
export function collectMoneyLiterals(
  toolName: string,
  data: unknown,
): Array<{ tool: string; path: string; value: string }> {
  const out: Array<{ tool: string; path: string; value: string }> = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string' && /^\d{1,3}(,\d{3})*\.\d{2}$/.test(v)) {
      out.push({ tool: toolName, path, value: v });
    } else if (typeof v === 'number' && Number.isInteger(v)) {
      out.push({ tool: toolName, path, value: String(v) });
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], `${path}[${i}]`);
    } else if (v !== null && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) walk(val, path === '' ? k : `${path}.${k}`);
    }
  };
  walk(data, '');
  return out;
}

export type { ApplicationFacade } from './application-facade.js';
export { Money };
