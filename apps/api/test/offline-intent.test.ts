import { describe, expect, it } from 'vitest';
import { routeOfflineIntent } from '../src/routes/offline-intent.js';

const ctx = { enterpriseId: 'C001', defaultMonth: '2026-09' };

function steps(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  const r = routeOfflineIntent(text, ctx);
  expect(r.kind).toBe('run');
  if (r.kind !== 'run') return [];
  return r.turns
    .flat()
    .filter((t) => t.type === 'tool-call')
    .map((t) => ({
      name: t.name ?? '',
      args: t.args ?? {},
    }));
}

describe('routeOfflineIntent', () => {
  it('金额/收支查询 → summarize_enterprise_month，月份取自文本', () => {
    const s = steps('甲企业 2026 年 8 月的发票和银行收支各是多少？');
    expect(s).toEqual([{ name: 'summarize_enterprise_month', args: { month: '2026-08' } }]);
  });

  it('未写月份时用默认税期', () => {
    expect(steps('查一下发票总金额')[0]?.args).toEqual({ month: '2026-09' });
  });

  it('缺项/用途未填 → find_purpose_gaps', () => {
    expect(steps('9 月有哪些发票没填用途？')[0]?.name).toBe('find_purpose_gaps');
    expect(steps('查缺项')[0]?.name).toBe('find_purpose_gaps');
  });

  it('补用途 → set_invoice_purpose，抽取发票号与内容', () => {
    const s = steps('把 F002 的用途填成「办公用品采购」');
    expect(s).toEqual([
      { name: 'set_invoice_purpose', args: { invoiceNo: 'F002', purpose: '办公用品采购' } },
    ]);
  });

  it('补备注 → set_invoice_remark', () => {
    const s = steps('给 F7 补备注「已核对原件」');
    expect(s).toEqual([
      { name: 'set_invoice_remark', args: { invoiceNo: 'F007', remark: '已核对原件' } },
    ]);
  });

  it('回写缺发票号 → 结构化澄清', () => {
    const r = routeOfflineIntent('把用途改成办公用品', ctx);
    expect(r.kind).toBe('clarify');
    if (r.kind === 'clarify') expect(r.message).toContain('发票号');
  });

  it('回写缺内容 → 结构化澄清', () => {
    const r = routeOfflineIntent('修改 F002 的用途', ctx);
    expect(r.kind).toBe('clarify');
  });

  it('未识别输入 → 澄清而非硬凑工具', () => {
    const r = routeOfflineIntent('今天天气怎么样', ctx);
    expect(r.kind).toBe('clarify');
    if (r.kind === 'clarify') expect(r.message).toContain('离线演示模式');
  });

  it('空输入 → 澄清', () => {
    expect(routeOfflineIntent('   ', ctx).kind).toBe('clarify');
  });
});
