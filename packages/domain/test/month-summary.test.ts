import { describe, expect, it } from 'vitest';
import type { EnterpriseId } from '../src/index.js';
import {
  BankTransaction,
  bankTransactionId,
  enterpriseId,
  Invoice,
  invoiceNo,
  parseIsoDate,
  parseMonth,
  summarizeBank,
  summarizeInvoices,
  userId,
} from '../src/index.js';
import { Money } from '../src/shared/money.js';

const C001 = enterpriseId('C001');
const C002 = enterpriseId('C002');
const ACTOR = userId('U001');
const SEP = parseMonth('2026-09');
const AUG = parseMonth('2026-08');
const JUL = parseMonth('2026-07');

/** fixtures/golden.ts: C001/2026-09 = 9622.06 */
const C001_SEP_INVOICES: readonly (readonly [string, string])[] = [
  ['F001', '500.00'],
  ['F002', '800.00'],
  ['F004', '999.99'],
  ['F005', '1000.00'],
  ['F003', '300.00'],
  ['F006', '1000.01'],
  ['F007', '1280.50'],
  ['F008', '2560.88'],
  ['F009', '680.68'],
  ['F010', '500.00'],
];

/** fixtures/golden.ts: C001/2026-09 = 支出 7180.74 / 收入 13000.50 */
const C001_SEP_BANK: readonly (readonly [string, 'income' | 'expense', string])[] = [
  ['T001', 'expense', '400.00'],
  ['T002', 'expense', '500.00'],
  ['T009', 'income', '3000.00'],
  ['T003', 'expense', '300.00'],
  ['T004', 'expense', '800.25'],
  ['T005', 'expense', '1000.00'],
  ['T010', 'income', '5200.50'],
  ['T006', 'expense', '999.99'],
  ['T007', 'expense', '500.00'],
  ['T011', 'income', '1800.00'],
  ['T008', 'expense', '2680.50'],
  ['T012', 'income', '3000.00'],
];

function invoice(enterprise: EnterpriseId, no: string, amount: string, issuedOn: string): Invoice {
  return Invoice.create({
    enterpriseId: enterprise,
    invoiceNo: invoiceNo(no),
    issuedOn: parseIsoDate(issuedOn),
    sellerName: '某供应商（模拟）',
    itemName: '某项目',
    amount: Money.parse(amount),
    updatedAt: parseIsoDate('2026-09-30'),
    updatedBy: ACTOR,
  });
}

function txn(
  no: string,
  direction: 'income' | 'expense',
  amount: string,
  on: string,
): BankTransaction {
  return BankTransaction.rehydrate({
    id: bankTransactionId('C001', no),
    occurredOn: parseIsoDate(on),
    direction,
    amount: Money.parse(amount),
    counterpartyName: '某对手方（模拟）',
    remark: null,
  });
}

function sepInvoices(): Invoice[] {
  return C001_SEP_INVOICES.map(([no, amt]) => invoice(C001, no, amt, '2026-09-15'));
}

function sepBank(): BankTransaction[] {
  return C001_SEP_BANK.map(([no, dir, amt]) => txn(no, dir, amt, '2026-09-15'));
}

describe('summarizeInvoices', () => {
  it('C001/2026-09 合计 9,622.06 元 / 10 张', () => {
    const s = summarizeInvoices(C001, SEP, sepInvoices());
    expect(s.invoiceCount).toBe(10);
    expect(s.totalInclTax.cents).toBe(962206n);
    expect(s.totalInclTax.format()).toBe('9,622.06');
    expect(s.outcome).toBe('records');
  });

  it('空月份合计 0.00 且 outcome 为 empty（区分「查到 0 条」与「没查」）', () => {
    const s = summarizeInvoices(C001, JUL, []);
    expect(s.invoiceCount).toBe(0);
    expect(s.totalInclTax.isZero()).toBe(true);
    expect(s.totalInclTax.format()).toBe('0.00');
    expect(s.outcome).toBe('empty');
  });

  it('按 issuedOn 二次过滤：跨月输入不会串月', () => {
    const spilling = [...sepInvoices(), invoice(C001, 'F011', '460.50', '2026-08-01')];
    const s = summarizeInvoices(C001, SEP, spilling);
    expect(s.invoiceCount).toBe(10);
    expect(s.totalInclTax.cents).toBe(962206n);
  });

  it('排除其他企业的发票', () => {
    const mixed = [...sepInvoices(), invoice(C002, 'F002', '1000.00', '2026-09-08')];
    const s = summarizeInvoices(C001, SEP, mixed);
    expect(s.invoiceCount).toBe(10);
    expect(s.totalInclTax.cents).toBe(962206n);
  });

  it('2026-08 同样对得上基准 9,046.35', () => {
    const aug = [
      invoice(C001, 'F011', '460.50', '2026-08-01'),
      invoice(C001, 'F012', '1200.00', '2026-08-03'),
      invoice(C001, 'F013', '339.50', '2026-08-06'),
      invoice(C001, 'F014', '999.99', '2026-08-09'),
      invoice(C001, 'F015', '1000.00', '2026-08-12'),
      invoice(C001, 'F016', '1000.01', '2026-08-16'),
      invoice(C001, 'F017', '2680.00', '2026-08-20'),
      invoice(C001, 'F018', '185.60', '2026-08-24'),
      invoice(C001, 'F019', '460.50', '2026-08-28'),
      invoice(C001, 'F020', '720.25', '2026-08-31'),
    ];
    const s = summarizeInvoices(C001, AUG, aug);
    expect(s.totalInclTax.cents).toBe(904635n);
    expect(s.totalInclTax.format()).toBe('9,046.35');
  });
});

describe('summarizeBank', () => {
  it('C001/2026-09 支出 7,180.74 / 收入 13,000.50', () => {
    const s = summarizeBank(C001, SEP, sepBank());
    expect(s.expenseTotal.cents).toBe(718074n);
    expect(s.expenseTotal.format()).toBe('7,180.74');
    expect(s.incomeTotal.cents).toBe(1300050n);
    expect(s.incomeTotal.format()).toBe('13,000.50');
    expect(s.incomeCount).toBe(4);
    expect(s.expenseCount).toBe(8);
    expect(s.outcome).toBe('records');
  });

  it('收入与支出永不净额化：等额的收支不会被抵消成 0', () => {
    const balanced = [
      txn('T001', 'income', '1000000.00', '2026-09-01'),
      txn('T002', 'expense', '1000000.00', '2026-09-02'),
    ];
    const s = summarizeBank(C001, SEP, balanced);
    expect(s.incomeTotal.format()).toBe('1,000,000.00');
    expect(s.expenseTotal.format()).toBe('1,000,000.00');
    expect(s.outcome).toBe('records');
    // 接口本身不提供 net 字段
    expect(Object.keys(s)).not.toContain('net');
    expect(Object.keys(s)).not.toContain('netTotal');
  });

  it('空月份：两侧均为 0.00，outcome 为 empty', () => {
    const s = summarizeBank(C001, JUL, []);
    expect(s.incomeTotal.isZero()).toBe(true);
    expect(s.expenseTotal.isZero()).toBe(true);
    expect(s.incomeCount).toBe(0);
    expect(s.expenseCount).toBe(0);
    expect(s.outcome).toBe('empty');
  });

  it('按 occurredOn 二次过滤，避免跨月流水混入', () => {
    const spilling = [...sepBank(), txn('T013', 'expense', '600.00', '2026-08-01')];
    const s = summarizeBank(C001, SEP, spilling);
    expect(s.expenseTotal.cents).toBe(718074n);
    expect(s.expenseCount).toBe(8);
  });
});
