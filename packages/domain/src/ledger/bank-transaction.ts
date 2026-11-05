import type { Brand } from '../shared/brand.js';
import { InvalidIdentifierError, InvalidTextError } from '../shared/domain-error.js';
import type { Money } from '../shared/money.js';
import type { IsoDate } from '../shared/month.js';

/** 银行流水号，形如 T001 / BANK0001。 */
export type TransactionNo = Brand<string, 'TransactionNo'>;
/** 银行流水复合标识：企业 + 流水号。 */
export type BankTransactionId = Brand<string, 'BankTransactionId'>;

const TRANSACTION_NO_RE = /^[A-Z]{1,4}\d{3,12}$/;

export function transactionNo(raw: string): TransactionNo {
  if (typeof raw !== 'string' || !TRANSACTION_NO_RE.test(raw)) {
    throw new InvalidIdentifierError('TransactionNo', raw, '应形如 T001');
  }
  return raw as TransactionNo;
}

export function bankTransactionId(enterprise: string, no: string): BankTransactionId {
  return `${enterprise}/${transactionNo(no)}` as BankTransactionId;
}

export type FlowDirection = 'income' | 'expense';

export interface BankTransactionSnapshot {
  readonly id: BankTransactionId;
  readonly occurredOn: IsoDate;
  readonly direction: FlowDirection;
  readonly amount: Money;
  readonly counterpartyName: string;
  readonly remark: string | null;
}

/**
 * 银行流水：**只读实体**。
 *
 * 类上故意不存在任何 change / delete 方法 —— 银行对账单是外部事实，
 * 记错了只能由数据源重新导入，不能让对话或任何用例改写。
 * 金额恒为正，方向由 `direction` 表达，因此汇总时收入与支出
 * 永远分列，不可能被静默抵消。
 */
export class BankTransaction {
  private constructor(
    readonly id: BankTransactionId,
    readonly occurredOn: IsoDate,
    readonly direction: FlowDirection,
    readonly amount: Money,
    readonly counterpartyName: string,
    readonly remark: string | null,
  ) {
    if (amount.isZero()) {
      throw new InvalidTextError('银行流水金额必须大于 0', { id });
    }
  }

  static rehydrate(s: BankTransactionSnapshot): BankTransaction {
    if (s.direction !== 'income' && s.direction !== 'expense') {
      throw new InvalidTextError(`未知的资金方向: ${String(s.direction)}`, { id: s.id });
    }
    return new BankTransaction(
      s.id,
      s.occurredOn,
      s.direction,
      s.amount,
      s.counterpartyName,
      s.remark,
    );
  }

  toSnapshot(): BankTransactionSnapshot {
    return {
      id: this.id,
      occurredOn: this.occurredOn,
      direction: this.direction,
      amount: this.amount,
      counterpartyName: this.counterpartyName,
      remark: this.remark,
    };
  }
}
