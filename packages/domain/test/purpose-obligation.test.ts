import { describe, expect, it } from 'vitest';
import type { EnterpriseId, PurposeObligation } from '../src/index.js';
import {
  atLeast,
  auditInvoices,
  auditPurpose,
  enterpriseId,
  Invoice,
  invoiceNo,
  isBatchCompliant,
  isBlankPurpose,
  isCompliant,
  PURPOSE_REQUIRED_ALL,
  parseIsoDate,
  userId,
} from '../src/index.js';
import { Money } from '../src/shared/money.js';

const C001 = enterpriseId('C001');
const C002 = enterpriseId('C002');
const ACTOR = userId('U001');
const AT = parseIsoDate('2026-09-30');

let _seq = 0;

function inv(
  enterprise: EnterpriseId,
  no: string,
  amount: string,
  purpose: string | null,
): Invoice {
  _seq += 1;
  return Invoice.create({
    enterpriseId: enterprise,
    invoiceNo: invoiceNo(no),
    issuedOn: parseIsoDate('2026-09-08'),
    sellerName: '某供应商（模拟）',
    itemName: '某项目',
    amount: Money.parse(amount),
    purpose,
    updatedAt: AT,
    updatedBy: ACTOR,
  });
}

describe('isBlankPurpose', () => {
  it('null / 空串 / 全空白都算空', () => {
    expect(isBlankPurpose(null)).toBe(true);
    expect(isBlankPurpose('')).toBe(true);
    expect(isBlankPurpose('   ')).toBe(true);
    expect(isBlankPurpose('\t\n ')).toBe(true);
  });

  it('任何非空白字符都算已填', () => {
    expect(isBlankPurpose('采购')).toBe(false);
    expect(isBlankPurpose(' 采购 ')).toBe(false);
    expect(isBlankPurpose('a')).toBe(false);
  });
});

describe('purpose_required_all（C001 适用 R002 v2.0）', () => {
  it('空用途 → missing', () => {
    expect(auditPurpose(inv(C001, 'F002', '800.00', null), PURPOSE_REQUIRED_ALL)).toBe('missing');
  });

  it('全空白用途 → missing', () => {
    expect(auditPurpose(inv(C001, 'F003', '300.00', '   '), PURPOSE_REQUIRED_ALL)).toBe('missing');
  });

  it('有用途 → present，不限金额', () => {
    expect(auditPurpose(inv(C001, 'F001', '500.00', '购买办公文具'), PURPOSE_REQUIRED_ALL)).toBe(
      'present',
    );
    // 低于 1000 且已填写，同样 present
    expect(auditPurpose(inv(C001, 'F010', '500.00', '日常文件打印'), PURPOSE_REQUIRED_ALL)).toBe(
      'present',
    );
  });
});

describe('purpose_required_at_least（C002 适用 R003 v1.0，门槛 1000.00）', () => {
  const ob = atLeast('1000.00');

  it('恰好 1000.00 元且空用途 → missing（门槛含等号）', () => {
    expect(auditPurpose(inv(C002, 'F002', '1000.00', null), ob)).toBe('missing');
  });

  it('999.99 元且空用途 → allowed-empty', () => {
    expect(auditPurpose(inv(C002, 'F004', '999.99', null), ob)).toBe('allowed-empty');
  });

  it('1000.01 元且空用途 → missing', () => {
    expect(auditPurpose(inv(C002, 'F005', '1000.01', null), ob)).toBe('missing');
  });

  it('低于门槛但已填写 → present（「已填」先于金额判定）', () => {
    // C002/F008 原表即为 600.00 + 「会议资料邮寄」
    expect(auditPurpose(inv(C002, 'F008', '600.00', '会议资料邮寄'), ob)).toBe('present');
  });

  it('高于门槛且已填写 → present', () => {
    expect(auditPurpose(inv(C002, 'F003', '1500.00', '购买展示用品'), ob)).toBe('present');
  });

  it('阈值比较走 bigint，不丢精度', () => {
    expect(auditPurpose(inv(C002, 'F009', '486.75', null), ob)).toBe('allowed-empty');
    expect(auditPurpose(inv(C002, 'F006', '1280.50', null), ob)).toBe('missing');
  });
});

describe('isCompliant', () => {
  it('present 与 allowed-empty 合规，missing 不合规', () => {
    expect(isCompliant('present')).toBe(true);
    expect(isCompliant('allowed-empty')).toBe(true);
    expect(isCompliant('missing')).toBe(false);
  });
});

describe('未知义务类型 fail closed', () => {
  it('未知 kind 抛出 UnsupportedRuleError，而不是退回「全部必填」', () => {
    const bogus = { kind: 'purpose_required_some' } as unknown as PurposeObligation;
    expect(() => auditPurpose(inv(C001, 'F002', '800.00', null), bogus)).toThrow();
  });
});

describe('auditInvoices 批量审计', () => {
  const c001Invoices = [
    inv(C001, 'F001', '500.00', '购买办公文具'),
    inv(C001, 'F002', '800.00', null),
    inv(C001, 'F003', '300.00', '   '),
    inv(C001, 'F004', '999.99', null),
    inv(C001, 'F005', '1000.00', '办公场地清洁'),
    inv(C001, 'F006', '1000.01', null),
    inv(C001, 'F007', '1280.50', '客户演示场地租用'),
    inv(C001, 'F008', '2560.88', '员工出差住宿'),
    inv(C001, 'F009', '680.68', null),
    inv(C001, 'F010', '500.00', '日常文件打印'),
  ];

  it('C001 在 purpose_required_all 下缺 5 张：F002 F003 F004 F006 F009', () => {
    const r = auditInvoices(C001, c001Invoices, PURPOSE_REQUIRED_ALL);
    expect(r.missing.map((m) => m.invoiceNo).sort()).toEqual([
      'F002',
      'F003',
      'F004',
      'F006',
      'F009',
    ]);
    expect(r.presentCount).toBe(5);
    expect(r.allowedEmpty).toEqual([]);
    expect(isBatchCompliant(r)).toBe(false);
  });

  it('缺口的金额以分给出，可回查', () => {
    const r = auditInvoices(C001, c001Invoices, PURPOSE_REQUIRED_ALL);
    const f004 = r.missing.find((m) => m.invoiceNo === 'F004');
    expect(f004?.amountCents).toBe(99999n);
  });

  it('C002 在 1000 门槛下缺 3 张、允许空 3 张', () => {
    const c002Invoices = [
      inv(C002, 'F001', '600.00', null),
      inv(C002, 'F002', '1000.00', null),
      inv(C002, 'F003', '1500.00', '购买展示用品'),
      inv(C002, 'F004', '999.99', null),
      inv(C002, 'F005', '1000.01', null),
      inv(C002, 'F006', '1280.50', null),
      inv(C002, 'F007', '3200.00', '客户交流会议场地'),
      inv(C002, 'F008', '600.00', '会议资料邮寄'),
      inv(C002, 'F009', '486.75', null),
      inv(C002, 'F010', '1999.99', '设备例行维护'),
    ];
    const r = auditInvoices(C002, c002Invoices, atLeast('1000.00'));
    expect(r.missing.map((m) => m.invoiceNo).sort()).toEqual(['F002', 'F005', 'F006']);
    expect(r.allowedEmpty.map((m) => m.invoiceNo).sort()).toEqual(['F001', 'F004', 'F009']);
    expect(r.presentCount).toBe(4);
  });

  it('只统计本企业的发票，跨企业输入被过滤', () => {
    const mixed = [inv(C001, 'F001', '500.00', null), inv(C002, 'F001', '600.00', null)];
    const r = auditInvoices(C001, mixed, PURPOSE_REQUIRED_ALL);
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0]?.invoiceNo).toBe('F001');
  });

  it('全部填齐时 isBatchCompliant 为真', () => {
    const r = auditInvoices(C001, [inv(C001, 'F001', '500.00', '采购')], PURPOSE_REQUIRED_ALL);
    expect(isBatchCompliant(r)).toBe(true);
  });
});
