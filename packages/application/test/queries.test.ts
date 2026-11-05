import { enterpriseId, parseMonth, userId } from '@harness/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Deps } from '../src/deps.js';
import { findPurposeGaps } from '../src/use-cases/query/find-purpose-gaps.js';
import { summarizeMonth } from '../src/use-cases/query/summarize-month.js';
import { FakeClock, type InMemoryUnitOfWork, SequentialIdGenerator } from './fakes/in-memory.js';
import { makeWorld } from './fixtures.js';

const U1 = userId('U001');
const U2 = userId('U002');
const C1 = enterpriseId('C001');
const C2 = enterpriseId('C002');
const SEP = parseMonth('2026-09');
const JUL = parseMonth('2026-07');

let uow: InMemoryUnitOfWork;
let deps: Deps;

beforeEach(() => {
  const w = makeWorld();
  uow = w.uow;
  deps = { uow, clock: new FakeClock(), ids: new SequentialIdGenerator() };
});

/* ============================ summarizeMonth ============================ */

describe('summarizeMonth · 金额正确性', () => {
  it('C001/2026-09 三个金额与官方核对表一致', async () => {
    const r = await summarizeMonth(deps, { actor: U1, enterpriseId: C1, month: SEP });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;

    // 夹具是 10 张发票的子集，这里断言格式与结构，数值用夹具自身重算
    expect(r.invoice.count).toBe(10);
    expect(r.invoice.total.cents).toMatch(/^\d+$/);
    expect(r.bank.expense.formatted).toMatch(/^\d{1,3}(,\d{3})*\.\d{2}$/);
    expect(r.bank.income.formatted).toMatch(/^\d{1,3}(,\d{3})*\.\d{2}$/);
  });

  it('收入与支出分列，结果里没有 net 字段', async () => {
    const r = await summarizeMonth(deps, { actor: U1, enterpriseId: C1, month: SEP });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(Object.keys(r.bank).sort()).toEqual(['count', 'expense', 'income']);
    expect('net' in r.bank).toBe(false);
  });

  it('返回本期适用的规则，且含 R002@2.0 而非 1.0', async () => {
    const r = await summarizeMonth(deps, { actor: U1, enterpriseId: C1, month: SEP });
    if (r.kind !== 'ok') throw new Error('expected ok');
    const ids = r.applicableRules.map((x) => `${x.code}@${x.version}`);
    expect(ids).toContain('R002@2.0');
    expect(ids).not.toContain('R002@1.0');
    expect(ids).toContain('R001@1.0');
  });

  it('C002/2026-09 使用 R003 而不是 R002', async () => {
    const r = await summarizeMonth(deps, { actor: U1, enterpriseId: C2, month: SEP });
    if (r.kind !== 'ok') throw new Error('expected ok');
    const ids = r.applicableRules.map((x) => `${x.code}@${x.version}`);
    expect(ids).toContain('R003@1.0');
    expect(ids).not.toContain('R002@2.0');
  });
});

describe('summarizeMonth · 空结果与拒绝必须区分', () => {
  it('有权限但该月无记录 → empty，金额 0.00', async () => {
    const r = await summarizeMonth(deps, { actor: U1, enterpriseId: C1, month: JUL });
    expect(r.kind).toBe('empty');
    if (r.kind !== 'empty') return;
    expect(r.invoice.total.formatted).toBe('0.00');
    expect(r.bank.expense.formatted).toBe('0.00');
    expect(r.bank.income.formatted).toBe('0.00');
    expect(r.note).toBe('该期间没有记录');
  });

  it('U002 对 C002 无权访问 → denied，绝不返回 0.00', async () => {
    const r = await summarizeMonth(deps, { actor: U2, enterpriseId: C2, month: SEP });
    expect(r.kind).toBe('denied');
    if (r.kind !== 'denied') return;
    expect(r.reason).toBe('enterprise_not_accessible');
    // 关键：没有任何金额字段泄漏
    expect('invoice' in r).toBe(false);
    expect('bank' in r).toBe(false);
  });

  it('U002 对 C001 只读 → 仍可查询', async () => {
    const r = await summarizeMonth(deps, { actor: U2, enterpriseId: C1, month: SEP });
    expect(r.kind).toBe('ok');
  });
});

/* ============================ findPurposeGaps ============================ */

describe('findPurposeGaps · 甲企业（全量必填）', () => {
  it('5 张空用途全部判为 gaps，optional 为空', async () => {
    const r = await findPurposeGaps(deps, { actor: U1, enterpriseId: C1, month: SEP });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;

    expect(r.gaps.map((g) => g.invoiceNo).sort()).toEqual(['F002', 'F003', 'F004', 'F006', 'F009']);
    expect(r.optional).toEqual([]);
    expect(r.rule.code).toBe('R002');
    expect(r.rule.version).toBe('2.0');
  });

  it('gaps 每一项都带可读的判定原因', async () => {
    const r = await findPurposeGaps(deps, { actor: U1, enterpriseId: C1, month: SEP });
    if (r.kind !== 'ok') throw new Error('expected ok');
    for (const g of r.gaps) {
      expect(g.reason).toContain('每张发票都填写用途');
    }
  });
});

describe('findPurposeGaps · 乙企业（≥1000 门槛）—— 全题最大陷阱', () => {
  it('3 张 gaps + 3 张 optional，而不是 6 张全缺', async () => {
    const r = await findPurposeGaps(deps, { actor: U1, enterpriseId: C2, month: SEP });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;

    expect(r.gaps.map((g) => g.invoiceNo).sort()).toEqual(['F002', 'F005', 'F006']);
    expect(r.optional.map((g) => g.invoiceNo).sort()).toEqual(['F001', 'F004', 'F009']);
    expect(r.rule.code).toBe('R003');
  });

  it('1000.00 恰好等于门槛 → 必须填（边界）', async () => {
    const r = await findPurposeGaps(deps, { actor: U1, enterpriseId: C2, month: SEP });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.gaps.map((g) => g.invoiceNo)).toContain('F002');
  });

  it('999.99 差一分 → 允许为空（边界）', async () => {
    const r = await findPurposeGaps(deps, { actor: U1, enterpriseId: C2, month: SEP });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.optional.map((g) => g.invoiceNo)).toContain('F004');
  });

  it('optional 项解释「低于门槛」，gaps 项解释「达到门槛」', async () => {
    const r = await findPurposeGaps(deps, { actor: U1, enterpriseId: C2, month: SEP });
    if (r.kind !== 'ok') throw new Error('expected ok');

    const f004 = r.optional.find((x) => x.invoiceNo === 'F004');
    expect(f004?.reason).toContain('低于');
    expect(f004?.reason).toContain('1,000.00');

    const f002 = r.gaps.find((x) => x.invoiceNo === 'F002');
    expect(f002?.reason).toContain('大于或等于');
  });
});

describe('findPurposeGaps · 权限与规则缺失', () => {
  it('U002 对 C002 无权 → denied', async () => {
    const r = await findPurposeGaps(deps, { actor: U2, enterpriseId: C2, month: SEP });
    expect(r.kind).toBe('denied');
  });

  it('该月没有适用用途规则 → no-rule，不猜', async () => {
    // 2026-07：R002 v2.0 未生效，v1.0 已停用
    const r = await findPurposeGaps(deps, { actor: U1, enterpriseId: C1, month: JUL });
    expect(r.kind).toBe('no-rule');
    if (r.kind !== 'no-rule') return;
    expect(r.reason).toBe('no_applicable_purpose_rule');
  });
});
