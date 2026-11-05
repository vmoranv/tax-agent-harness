import type { AccessDecision, MutableField } from '../identity/access-policy.js';
import {
  IdempotencyConflictError,
  InvalidTextError,
  InvoiceInvariantError,
} from '../shared/domain-error.js';
import type { RequestId } from '../shared/domain-event.js';
import type { EnterpriseId, InvoiceNo, UserId } from '../shared/ids.js';
import { InvoiceId } from '../shared/ids.js';
import type { Money } from '../shared/money.js';
import type { IsoDate } from '../shared/month.js';
import { isBlankText } from '../shared/text.js';

export const MAX_PURPOSE = 200;
export const MAX_REMARK = 500;

/** 规范化后的用途：非空、trim 后 1..200；空白一律 null。 */
export type InvoicePurpose = string;
/** 规范化后的备注：trim 后 1..500；空白一律 null。 */
export type InvoiceRemark = string;

/** null / '' / 全空白 → null；其余 trim。 */
export function normalizePurpose(raw: string | null): InvoicePurpose | null {
  if (raw === null) return null;
  const s = raw.trim();
  if (s.length === 0) return null;
  if (s.length > MAX_PURPOSE) {
    throw new InvalidTextError(`用途不能超过 ${MAX_PURPOSE} 个字符`, {
      length: s.length,
      max: MAX_PURPOSE,
    });
  }
  return s;
}

export function normalizeRemark(raw: string | null): InvoiceRemark | null {
  if (raw === null) return null;
  const s = raw.trim();
  if (s.length === 0) return null;
  if (s.length > MAX_REMARK) {
    throw new InvalidTextError(`备注不能超过 ${MAX_REMARK} 个字符`, {
      length: s.length,
      max: MAX_REMARK,
    });
  }
  return s;
}

/** 单次写入的历史记录。 */
export interface InvoiceChangeRecord {
  readonly requestId: RequestId;
  readonly field: MutableField;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly actorId: UserId;
  readonly changedAt: IsoDate;
  readonly resultingVersion: number;
}

export interface InvoicePurposeChanged {
  readonly type: 'ledger.invoice-purpose-changed';
  readonly invoiceId: InvoiceId;
  readonly enterpriseId: EnterpriseId;
  readonly invoiceNo: InvoiceNo;
  readonly oldPurpose: string | null;
  readonly newPurpose: string;
  readonly actorId: UserId;
  readonly requestId: RequestId;
  readonly version: number;
  readonly occurredAt: IsoDate;
}

export interface InvoiceRemarkChanged {
  readonly type: 'ledger.invoice-remark-changed';
  readonly invoiceId: InvoiceId;
  readonly enterpriseId: EnterpriseId;
  readonly invoiceNo: InvoiceNo;
  readonly oldRemark: string | null;
  readonly newRemark: string;
  readonly actorId: UserId;
  readonly requestId: RequestId;
  readonly version: number;
  readonly occurredAt: IsoDate;
}

export type InvoiceChangeEvent = InvoicePurposeChanged | InvoiceRemarkChanged;

export type ChangeOutcome =
  | {
      readonly status: 'applied';
      readonly event: InvoiceChangeEvent;
      readonly record: InvoiceChangeRecord;
    }
  | { readonly status: 'replayed'; readonly record: InvoiceChangeRecord };

/** 快照（持久化与回读复核的共同形态）。 */
export interface InvoiceSnapshot {
  readonly id: InvoiceId;
  readonly enterpriseId: EnterpriseId;
  readonly invoiceNo: InvoiceNo;
  readonly issuedOn: IsoDate;
  readonly sellerName: string;
  readonly itemName: string;
  readonly amount: Money;
  readonly purpose: InvoicePurpose | null;
  readonly remark: InvoiceRemark | null;
  readonly version: number;
  readonly updatedAt: IsoDate;
  readonly updatedBy: UserId;
}

/**
 * 写权限闸门。
 *
 * 不接受「上层已判断过」的口头保证：决策对象必须与本发票的企业、
 * 目标字段逐一匹配，否则拒绝。这样即便调用方误用了别的授权，
 * 也无法把 A 企业的写权限套到 B 企业头上。
 */
function assertWritable(inv: Invoice, decision: AccessDecision, field: MutableField): void {
  if (!decision.allowed) {
    throw new InvoiceInvariantError(`写入被拒绝：${decision.message}`, {
      invoiceId: inv.id.value(),
      field,
      reason: decision.reason,
    });
  }
  if (decision.field !== field) {
    throw new InvoiceInvariantError('写入决策的字段与实际字段不一致', {
      invoiceId: inv.id.value(),
      expected: field,
      actual: decision.field,
    });
  }
  if (decision.enterpriseId !== inv.enterpriseId) {
    throw new InvoiceInvariantError('写入决策的企业与发票企业不一致', {
      invoiceId: inv.id.value(),
      invoiceEnterprise: inv.enterpriseId,
      decisionEnterprise: decision.enterpriseId,
    });
  }
}

/**
 * 发票聚合根。
 *
 * 只有 `changePurpose` / `changeRemark` 两个变更入口；
 * 企业、编号、日期、销方、品名、金额均为只读字段，类上没有任何
 * 对应的 setter 或可变方法 —— 这是「金额不可被对话改写」的结构性保证。
 */
export class Invoice {
  private constructor(
    readonly id: InvoiceId,
    readonly enterpriseId: EnterpriseId,
    readonly invoiceNo: InvoiceNo,
    readonly issuedOn: IsoDate,
    readonly sellerName: string,
    readonly itemName: string,
    readonly amount: Money,
    private purposeValue: InvoicePurpose | null,
    private remarkValue: InvoiceRemark | null,
    private versionValue: number,
    private updatedAtValue: IsoDate,
    private updatedByValue: UserId,
    private readonly applied: InvoiceChangeRecord[],
  ) {}

  static rehydrate(s: InvoiceSnapshot, history: readonly InvoiceChangeRecord[] = []): Invoice {
    if (s.id.enterpriseId !== s.enterpriseId) {
      throw new InvoiceInvariantError('InvoiceId 中的企业与快照企业不一致', {
        invoiceId: s.id.value(),
        snapshotEnterprise: s.enterpriseId,
      });
    }
    return new Invoice(
      s.id,
      s.enterpriseId,
      s.invoiceNo,
      s.issuedOn,
      s.sellerName,
      s.itemName,
      s.amount,
      s.purpose,
      s.remark,
      s.version,
      s.updatedAt,
      s.updatedBy,
      [...history],
    );
  }

  /** 装配新发票（导入用）。不产生变更事件。 */
  static create(input: {
    enterpriseId: EnterpriseId;
    invoiceNo: InvoiceNo;
    issuedOn: IsoDate;
    sellerName: string;
    itemName: string;
    amount: Money;
    purpose?: string | null;
    remark?: string | null;
    updatedAt: IsoDate;
    updatedBy: UserId;
  }): Invoice {
    return new Invoice(
      InvoiceId.of(input.enterpriseId, input.invoiceNo),
      input.enterpriseId,
      input.invoiceNo,
      input.issuedOn,
      input.sellerName,
      input.itemName,
      input.amount,
      normalizePurpose(input.purpose ?? null),
      normalizeRemark(input.remark ?? null),
      1,
      input.updatedAt,
      input.updatedBy,
      [],
    );
  }

  get purpose(): InvoicePurpose | null {
    return this.purposeValue;
  }

  get remark(): InvoiceRemark | null {
    return this.remarkValue;
  }

  get version(): number {
    return this.versionValue;
  }

  get updatedAt(): IsoDate {
    return this.updatedAtValue;
  }

  get updatedBy(): UserId {
    return this.updatedByValue;
  }

  /** 只考察 purpose；remark 永不参与合规判定。 */
  isPurposeMissing(): boolean {
    return isBlankText(this.purposeValue);
  }

  changePurpose(
    next: string | null,
    decision: AccessDecision,
    requestId: RequestId,
    actor: UserId,
    at: IsoDate,
  ): ChangeOutcome {
    assertWritable(this, decision, 'purpose');
    const nextValue = normalizePurpose(next);
    return this.applyChange('purpose', nextValue, requestId, actor, at);
  }

  changeRemark(
    next: string | null,
    decision: AccessDecision,
    requestId: RequestId,
    actor: UserId,
    at: IsoDate,
  ): ChangeOutcome {
    assertWritable(this, decision, 'remark');
    const nextValue = normalizeRemark(next);
    return this.applyChange('remark', nextValue, requestId, actor, at);
  }

  snapshot(): InvoiceSnapshot {
    return {
      id: this.id,
      enterpriseId: this.enterpriseId,
      invoiceNo: this.invoiceNo,
      issuedOn: this.issuedOn,
      sellerName: this.sellerName,
      itemName: this.itemName,
      amount: this.amount,
      purpose: this.purposeValue,
      remark: this.remarkValue,
      version: this.versionValue,
      updatedAt: this.updatedAtValue,
      updatedBy: this.updatedByValue,
    };
  }

  changeHistory(): readonly InvoiceChangeRecord[] {
    return [...this.applied];
  }

  private applyChange(
    field: MutableField,
    nextValue: string | null,
    requestId: RequestId,
    actor: UserId,
    at: IsoDate,
  ): ChangeOutcome {
    const previous = this.applied.find((r) => r.requestId === requestId);
    if (previous !== undefined) {
      const samePayload = previous.field === field && previous.newValue === nextValue;
      if (!samePayload) {
        throw new IdempotencyConflictError('同一 requestId 携带了不同的写入内容', {
          requestId,
          invoiceId: this.id.value(),
          field,
        });
      }
      return { status: 'replayed', record: previous };
    }

    const oldValue = field === 'purpose' ? this.purposeValue : this.remarkValue;
    if (oldValue === nextValue) {
      // 同值写入：不升版本、不发事件、不写历史。
      return {
        status: 'replayed',
        record: {
          requestId,
          field,
          oldValue,
          newValue: nextValue,
          actorId: actor,
          changedAt: at,
          resultingVersion: this.versionValue,
        },
      };
    }

    if (field === 'purpose') {
      this.purposeValue = nextValue;
    } else {
      this.remarkValue = nextValue;
    }
    this.versionValue += 1;
    this.updatedAtValue = at;
    this.updatedByValue = actor;

    const record: InvoiceChangeRecord = {
      requestId,
      field,
      oldValue,
      newValue: nextValue,
      actorId: actor,
      changedAt: at,
      resultingVersion: this.versionValue,
    };
    this.applied.push(record);

    const event: InvoiceChangeEvent =
      field === 'purpose'
        ? {
            type: 'ledger.invoice-purpose-changed',
            invoiceId: this.id,
            enterpriseId: this.enterpriseId,
            invoiceNo: this.invoiceNo,
            oldPurpose: oldValue,
            newPurpose: nextValue ?? '',
            actorId: actor,
            requestId,
            version: this.versionValue,
            occurredAt: at,
          }
        : {
            type: 'ledger.invoice-remark-changed',
            invoiceId: this.id,
            enterpriseId: this.enterpriseId,
            invoiceNo: this.invoiceNo,
            oldRemark: oldValue,
            newRemark: nextValue ?? '',
            actorId: actor,
            requestId,
            version: this.versionValue,
            occurredAt: at,
          };

    return { status: 'applied', event, record };
  }
}
