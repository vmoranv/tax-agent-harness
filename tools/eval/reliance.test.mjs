/**
 * reliance 监控判据单测（vitest，随 `pnpm test` 一起跑）。
 * 覆盖：expression≠reliance 的核心判据、金额溯源、失败工具不计入、追问类不适用。
 */
import { describe, expect, it } from 'vitest';
import { checkReliance, evidenceLiterals } from './reliance.mjs';

// 真实 trace 结构：summarize 工具结果带 invoice.total / bank.expense / income
const TOOL_CALLS = [
  {
    ok: true,
    result: {
      enterprise: '甲企业',
      month: '2026-09',
      invoice: { count: 10, total: '9,622.06' },
      bank: { expense: '7,180.74', income: '13,000.50' },
      rules: ['R001 金额统计说明 v1.0'],
    },
  },
];

describe('reliance 监控（expression≠reliance）', () => {
  it('evidenceLiterals 从工具结果抽出 3 个金额', () => {
    expect(evidenceLiterals(TOOL_CALLS).size).toBe(3);
  });

  it('amount：gold 在本轮工具结果 → reliance ok', () => {
    expect(checkReliance({ kind: 'amount', goldInvoice: '9,622.06' }, TOOL_CALLS).ok).toBe(true);
  });

  it('amount：gold 不在工具结果（凭记忆/历史数字蒙对）→ reliance FAIL', () => {
    expect(checkReliance({ kind: 'amount', goldInvoice: '9,999.99' }, TOOL_CALLS).ok).toBe(false);
  });

  it('split：支出收入都在 → reliance ok', () => {
    const spec = { kind: 'split', goldExpense: '7,180.74', goldIncome: '13,000.50' };
    expect(checkReliance(spec, TOOL_CALLS).ok).toBe(true);
  });

  it('split：少一个金额 → reliance FAIL', () => {
    const spec = { kind: 'split', goldExpense: '7,180.74', goldIncome: '9,999.99' };
    expect(checkReliance(spec, TOOL_CALLS).ok).toBe(false);
  });

  it('千分位格式差异不影响匹配', () => {
    expect(checkReliance({ kind: 'amount', goldInvoice: '9622.06' }, TOOL_CALLS).ok).toBe(true);
  });

  it('零工具结果 → amount reliance FAIL', () => {
    expect(checkReliance({ kind: 'amount', goldInvoice: '9,622.06' }, []).ok).toBe(false);
  });

  it('失败工具(ok:false)的结果不计入证据', () => {
    const calls = [{ ok: false, result: { total: '9,622.06' } }];
    expect(checkReliance({ kind: 'amount', goldInvoice: '9,622.06' }, calls).ok).toBe(false);
  });

  it('追问类 / 权限类 applicable=false', () => {
    expect(checkReliance({ kind: 'no-biz-tool' }, TOOL_CALLS).applicable).toBe(false);
    expect(checkReliance({ kind: 'no-write' }, TOOL_CALLS).applicable).toBe(false);
  });
});
