import type { EnterpriseId } from '../shared/ids.js';
import { Money } from '../shared/money.js';
import type { Month } from '../shared/month.js';
import type { BankTransaction } from './bank-transaction.js';
import type { Invoice } from './invoice.js';

/** 发票月度汇总。`outcome` 区分「查到了 0 条」与「没查」。 */
export interface InvoiceSummary {
  readonly enterpriseId: EnterpriseId;
  readonly month: Month;
  readonly invoiceCount: number;
  readonly totalInclTax: Money;
  readonly outcome: 'records' | 'empty';
}

/**
 * 银行月度汇总。
 *
 * **没有 net 字段，这是刻意的**：收入与支出分别累加，绝不抵消。
 * 抵掉一笔 100 万收入和一笔 100 万支出会得出「本月无流水」，
 * 那是把两笔真实交易抹掉，属于最典型的误报。
 */
export interface BankFlowSummary {
  readonly enterpriseId: EnterpriseId;
  readonly month: Month;
  readonly incomeTotal: Money;
  readonly expenseTotal: Money;
  readonly incomeCount: number;
  readonly expenseCount: number;
  readonly outcome: 'records' | 'empty';
}

/**
 * 汇总发票（领域服务，纯函数）。
 *
 * 调用方负责传入已按企业+月份筛选过的集合；本函数仍会按
 * `issuedOn` 落在该月内再过滤一次，避免上游多传造成串月。
 */
export function summarizeInvoices(
  enterpriseId: EnterpriseId,
  month: Month,
  invoices: readonly Invoice[],
): InvoiceSummary {
  let total = Money.zero();
  let count = 0;

  for (const inv of invoices) {
    if (inv.enterpriseId !== enterpriseId) continue;
    if (!inv.issuedOn.startsWith(month)) continue;
    total = total.add(inv.amount);
    count += 1;
  }

  return {
    enterpriseId,
    month,
    invoiceCount: count,
    totalInclTax: total,
    outcome: count === 0 ? 'empty' : 'records',
  };
}

/** 汇总银行流水：收入与支出分别累加，永不净额化。 */
export function summarizeBank(
  enterpriseId: EnterpriseId,
  month: Month,
  transactions: readonly BankTransaction[],
): BankFlowSummary {
  let income = Money.zero();
  let expense = Money.zero();
  let incomeCount = 0;
  let expenseCount = 0;

  for (const txn of transactions) {
    if (!txn.occurredOn.startsWith(month)) continue;
    if (txn.direction === 'income') {
      income = income.add(txn.amount);
      incomeCount += 1;
    } else {
      expense = expense.add(txn.amount);
      expenseCount += 1;
    }
  }

  const empty = incomeCount === 0 && expenseCount === 0;
  return {
    enterpriseId,
    month,
    incomeTotal: income,
    expenseTotal: expense,
    incomeCount,
    expenseCount,
    outcome: empty ? 'empty' : 'records',
  };
}
