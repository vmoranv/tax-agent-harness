import { describe, expect, it } from 'vitest';
import {
  enterpriseId,
  InvalidIdentifierError,
  InvoiceId,
  invoiceNo,
  ruleCode,
  ruleVersion,
  userId,
} from '../src/index.js';

describe('InvoiceId 复合标识', () => {
  it('拆分企业号与发票号并拼回字符串', () => {
    const id = InvoiceId.of('C001', 'F001');
    expect(id.enterpriseId).toBe('C001');
    expect(id.invoiceNo).toBe('F001');
    expect(id.value()).toBe('C001/F001');
  });

  it('跨企业的同号发票不相等', () => {
    const a = InvoiceId.of('C001', 'F001');
    const b = InvoiceId.of('C002', 'F001');
    expect(a.equals(b)).toBe(false);
    expect(a.value()).not.toBe(b.value());
  });

  it('同企业同号相等', () => {
    expect(InvoiceId.of('C001', 'F002').equals(InvoiceId.parse('C001/F002'))).toBe(true);
  });

  it('parse / value 往返一致', () => {
    const raw = 'C002/F010';
    expect(InvoiceId.parse(raw).value()).toBe(raw);
  });

  it('parse 拒绝不合法格式', () => {
    expect(() => InvoiceId.parse('C001')).toThrow(InvalidIdentifierError);
    expect(() => InvoiceId.parse('C001/')).toThrow(InvalidIdentifierError);
    expect(() => InvoiceId.parse('/F001')).toThrow(InvalidIdentifierError);
    expect(() => InvoiceId.parse('C001/F001/x')).toThrow(InvalidIdentifierError);
    expect(() => InvoiceId.parse('C1/F001')).toThrow(InvalidIdentifierError);
    expect(() => InvoiceId.parse('C001/F1')).toThrow(InvalidIdentifierError);
  });

  it('of 拒绝不合法编号', () => {
    expect(() => InvoiceId.of('c001', 'F001')).toThrow(InvalidIdentifierError);
    expect(() => InvoiceId.of('C001', 'f001')).toThrow(InvalidIdentifierError);
  });
});

describe('标识构造函数', () => {
  it('接受合法格式', () => {
    expect(userId('U001')).toBe('U001');
    expect(enterpriseId('C002')).toBe('C002');
    expect(invoiceNo('F020')).toBe('F020');
    expect(ruleCode('R002')).toBe('R002');
    expect(ruleVersion('2.0')).toBe('2.0');
  });

  it('拒绝非法格式', () => {
    expect(() => userId('U01')).toThrow(InvalidIdentifierError);
    expect(() => enterpriseId('X001')).toThrow(InvalidIdentifierError);
    expect(() => invoiceNo('F1')).toThrow(InvalidIdentifierError);
    expect(() => ruleCode('R2')).toThrow(InvalidIdentifierError);
    expect(() => ruleVersion('v1')).toThrow(InvalidIdentifierError);
    expect(() => ruleVersion('1')).toThrow(InvalidIdentifierError);
  });
});
