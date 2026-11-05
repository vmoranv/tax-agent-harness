import { describe, expect, it } from 'vitest';
import type { AccessDecision, MutableField } from '../src/index.js';
import {
  decideRead,
  decideWrite,
  enterpriseId,
  IdempotencyConflictError,
  Invoice,
  InvoiceInvariantError,
  invoiceNo,
  parseIsoDate,
  parseRequestId,
  userId,
} from '../src/index.js';
import { Money } from '../src/shared/money.js';

const ENTERPRISE = enterpriseId('C001');
const ACTOR = userId('U001');
const AT = parseIsoDate('2026-09-10');

function newInvoice(amount = '800.00', purpose: string | null = null): Invoice {
  return Invoice.create({
    enterpriseId: ENTERPRISE,
    invoiceNo: invoiceNo('F002'),
    issuedOn: parseIsoDate('2026-09-08'),
    sellerName: '书林图文（模拟）',
    itemName: '复印纸、打印服务',
    amount: Money.parse(amount),
    purpose,
    updatedAt: AT,
    updatedBy: ACTOR,
  });
}

/** 针对指定字段的合法决策（等价于 decideWrite 的允许分支）。 */
function allow(field: MutableField): AccessDecision {
  return { allowed: true, enterpriseId: ENTERPRISE, field };
}

describe('Invoice 变更入口', () => {
  it('不存在任何改动金额/编号/企业/日期的入口', () => {
    const inv = newInvoice();
    const unsafe = inv as unknown as Record<string, unknown>;
    for (const forbidden of [
      'changeAmount',
      'setAmount',
      'updateAmount',
      'changeInvoiceNo',
      'changeEnterpriseId',
      'changeIssuedOn',
      'changeSellerName',
      'changeItemName',
    ]) {
      expect(unsafe[forbidden]).toBeUndefined();
    }
    // 只读属性没有 setter（快照值保持不可变）
    expect(
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inv), 'amount')?.set,
    ).toBeUndefined();
    expect(
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inv), 'invoiceNo')?.set,
    ).toBeUndefined();
    expect(inv.amount.cents).toBe(80000n);
  });

  it('金额与编号在 create 之后无法通过任何方法改动', () => {
    const inv = newInvoice();
    const before = inv.snapshot();
    inv.changePurpose('购买办公文具', allow('purpose'), parseRequestId('req-1'), ACTOR, AT);
    const after = inv.snapshot();
    expect(after.amount).toEqual(before.amount);
    expect(after.invoiceNo).toBe(before.invoiceNo);
    expect(after.issuedOn).toBe(before.issuedOn);
    expect(after.sellerName).toBe(before.sellerName);
    expect(after.itemName).toBe(before.itemName);
  });

  it('changePurpose 成功写入：版本 +1、历史 +1、返回 applied 事件', () => {
    const inv = newInvoice();
    const out = inv.changePurpose(
      '购买办公文具',
      allow('purpose'),
      parseRequestId('req-1'),
      ACTOR,
      AT,
    );
    expect(out.status).toBe('applied');
    expect(inv.purpose).toBe('购买办公文具');
    expect(inv.version).toBe(2);
    expect(inv.changeHistory()).toHaveLength(1);
    expect(inv.isPurposeMissing()).toBe(false);
    if (out.status === 'applied') {
      expect(out.event.type).toBe('ledger.invoice-purpose-changed');
      expect(out.record.resultingVersion).toBe(2);
    }
  });

  it('同一 requestId + 同内容 → replayed，不再升版本', () => {
    const inv = newInvoice();
    const req = parseRequestId('req-1');
    const first = inv.changePurpose('购买办公文具', allow('purpose'), req, ACTOR, AT);
    const second = inv.changePurpose('购买办公文具', allow('purpose'), req, ACTOR, AT);
    expect(first.status).toBe('applied');
    expect(second.status).toBe('replayed');
    expect(inv.version).toBe(2);
    expect(inv.changeHistory()).toHaveLength(1);
  });

  it('同一 requestId + 不同内容 → IdempotencyConflictError', () => {
    const inv = newInvoice();
    const req = parseRequestId('req-1');
    inv.changePurpose('购买办公文具', allow('purpose'), req, ACTOR, AT);
    expect(() => inv.changePurpose('买纸', allow('purpose'), req, ACTOR, AT)).toThrow(
      IdempotencyConflictError,
    );
  });

  it('写入与当前值相同 → replayed，不升版本、不发事件', () => {
    const inv = newInvoice('800.00', '已有用途');
    const out = inv.changePurpose('已有用途', allow('purpose'), parseRequestId('req-2'), ACTOR, AT);
    expect(out.status).toBe('replayed');
    expect(inv.version).toBe(1);
    expect(inv.changeHistory()).toHaveLength(0);
  });

  it('空白用途统一归一化为 null', () => {
    const inv = newInvoice('800.00', '已有用途');
    for (const blank of ['', '   ', '\t\n']) {
      const fresh = newInvoice('800.00', '已有用途');
      fresh.changePurpose(
        blank,
        allow('purpose'),
        parseRequestId(`req-${blank.length}-${blank.trim()}`),
        ACTOR,
        AT,
      );
      expect(fresh.purpose).toBeNull();
      expect(fresh.isPurposeMissing()).toBe(true);
    }
    inv.changePurpose(null, allow('purpose'), parseRequestId('req-null'), ACTOR, AT);
    expect(inv.purpose).toBeNull();
  });

  it('拒绝来自其他企业的决策', () => {
    const inv = newInvoice();
    const foreign: AccessDecision = {
      allowed: true,
      enterpriseId: enterpriseId('C002'),
      field: 'purpose',
    };
    expect(() => inv.changePurpose('x', foreign, parseRequestId('req-3'), ACTOR, AT)).toThrow(
      InvoiceInvariantError,
    );
  });

  it('拒绝来自其他字段的决策', () => {
    const inv = newInvoice();
    expect(() =>
      inv.changePurpose('x', allow('remark'), parseRequestId('req-4'), ACTOR, AT),
    ).toThrow(InvoiceInvariantError);
  });

  it('拒绝 allowed=false 的决策', () => {
    const inv = newInvoice();
    const denied = decideWrite(decideRead(null) as never, 'purpose');
    expect(() => inv.changePurpose('x', denied, parseRequestId('req-5'), ACTOR, AT)).toThrow(
      InvoiceInvariantError,
    );
  });

  it('read-only 决策无法写（decideWrite 输出被闸门拦截）', () => {
    const inv = newInvoice();
    const readOnly = {
      allowed: false as const,
      reason: 'read_only_enterprise' as const,
      message: '只读',
    };
    expect(() => inv.changePurpose('x', readOnly, parseRequestId('req-6'), ACTOR, AT)).toThrow(
      InvoiceInvariantError,
    );
  });
});

describe('Invoice changeRemark', () => {
  it('备注可独立变更，不影响用途', () => {
    const inv = newInvoice();
    const out = inv.changeRemark(
      '月底资料整理',
      allow('remark'),
      parseRequestId('req-r1'),
      ACTOR,
      AT,
    );
    expect(out.status).toBe('applied');
    expect(inv.remark).toBe('月底资料整理');
    expect(inv.purpose).toBeNull();
    expect(inv.version).toBe(2);
  });

  it('备注空白归一化为 null', () => {
    const inv = newInvoice();
    inv.changeRemark('  ', allow('remark'), parseRequestId('req-r2'), ACTOR, AT);
    expect(inv.remark).toBeNull();
    expect(inv.version).toBe(1);
  });

  it('备注不参与用途合规判定', () => {
    const inv = newInvoice();
    inv.changeRemark('说明文字', allow('remark'), parseRequestId('req-r3'), ACTOR, AT);
    expect(inv.isPurposeMissing()).toBe(true);
  });
});

describe('Invoice 快照与回读', () => {
  it('rehydrate 保留版本与历史', () => {
    const inv = newInvoice();
    inv.changePurpose('购买办公文具', allow('purpose'), parseRequestId('req-7'), ACTOR, AT);
    const restored = Invoice.rehydrate(inv.snapshot(), inv.changeHistory());
    expect(restored.version).toBe(2);
    expect(restored.purpose).toBe('购买办公文具');
    expect(restored.changeHistory()).toHaveLength(1);
  });

  it('rehydrate 拒绝 InvoiceId 中企业与快照企业不一致', () => {
    const inv = newInvoice();
    const snap = { ...inv.snapshot(), enterpriseId: enterpriseId('C002') };
    expect(() => Invoice.rehydrate(snap)).toThrow(InvoiceInvariantError);
  });

  it('企业内的同号发票与另一企业的是不同标识', () => {
    const a = newInvoice();
    const b = Invoice.create({
      enterpriseId: enterpriseId('C002'),
      invoiceNo: invoiceNo('F002'),
      issuedOn: parseIsoDate('2026-09-08'),
      sellerName: '星河印刷（模拟）',
      itemName: '宣传资料印刷',
      amount: Money.parse('1000.00'),
      updatedAt: AT,
      updatedBy: ACTOR,
    });
    expect(a.id.equals(b.id)).toBe(false);
  });
});
