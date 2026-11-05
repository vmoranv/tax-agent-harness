import type { Brand } from './brand.js';
import { InvalidIdentifierError } from './domain-error.js';

/** 用户标识，形如 U001。 */
export type UserId = Brand<string, 'UserId'>;
/** 企业标识，形如 C001。 */
export type EnterpriseId = Brand<string, 'EnterpriseId'>;
/** 发票号（企业内唯一），形如 F002。 */
export type InvoiceNo = Brand<string, 'InvoiceNo'>;
/** 规则编号，形如 R002。 */
export type RuleCode = Brand<string, 'RuleCode'>;
/** 规则版本，形如 2.0。 */
export type RuleVersion = Brand<string, 'RuleVersion'>;

const USER_ID_RE = /^U\d{3}$/;
const ENTERPRISE_ID_RE = /^C\d{3}$/;
const INVOICE_NO_RE = /^F\d{3}$/;
const RULE_CODE_RE = /^R\d{3}$/;
const RULE_VERSION_RE = /^\d+\.\d+$/;

function checked<T extends string>(kind: string, raw: string, re: RegExp, hint: string): T {
  if (typeof raw !== 'string' || !re.test(raw)) {
    throw new InvalidIdentifierError(kind, raw, hint);
  }
  return raw as T;
}

export function userId(raw: string): UserId {
  return checked<UserId>('UserId', raw, USER_ID_RE, '应形如 U001');
}

export function enterpriseId(raw: string): EnterpriseId {
  return checked<EnterpriseId>('EnterpriseId', raw, ENTERPRISE_ID_RE, '应形如 C001');
}

export function invoiceNo(raw: string): InvoiceNo {
  return checked<InvoiceNo>('InvoiceNo', raw, INVOICE_NO_RE, '应形如 F002');
}

export function ruleCode(raw: string): RuleCode {
  return checked<RuleCode>('RuleCode', raw, RULE_CODE_RE, '应形如 R002');
}

export function ruleVersion(raw: string): RuleVersion {
  return checked<RuleVersion>('RuleVersion', raw, RULE_VERSION_RE, '应形如 2.0');
}

/**
 * 发票复合标识：企业 + 发票号。
 *
 * 不同企业的同号发票（C001/F001 与 C002/F001）是两个不同的标识，
 * 绝不能退化成单个字符串比较。
 */
export class InvoiceId {
  private constructor(
    readonly enterpriseId: EnterpriseId,
    readonly invoiceNo: InvoiceNo,
  ) {
    Object.freeze(this);
  }

  static of(enterprise: string, no: string): InvoiceId {
    return new InvoiceId(enterpriseId(enterprise), invoiceNo(no));
  }

  /** 解析 'C001/F002'。 */
  static parse(raw: string): InvoiceId {
    const parts = raw.split('/');
    if (parts.length !== 2) {
      throw new InvalidIdentifierError('InvoiceId', raw, '应形如 C001/F002');
    }
    const ent = parts[0];
    const no = parts[1];
    if (ent === undefined || no === undefined || ent === '' || no === '') {
      throw new InvalidIdentifierError('InvoiceId', raw, '应形如 C001/F002');
    }
    return InvoiceId.of(ent, no);
  }

  equals(other: InvoiceId): boolean {
    return this.enterpriseId === other.enterpriseId && this.invoiceNo === other.invoiceNo;
  }

  value(): string {
    return `${this.enterpriseId}/${this.invoiceNo}`;
  }

  toString(): string {
    return this.value();
  }
}
