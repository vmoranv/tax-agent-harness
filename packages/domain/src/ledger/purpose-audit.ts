import type { EnterpriseId, InvoiceNo } from '../shared/ids.js';
import type { Invoice } from './invoice.js';
import type { PurposeObligation, PurposeVerdict } from './purpose-obligation.js';
import { auditPurpose } from './purpose-obligation.js';

export interface PurposeAuditItem {
  readonly invoiceNo: InvoiceNo;
  readonly amountCents: bigint;
  readonly verdict: PurposeVerdict;
}

export interface PurposeAuditResult {
  /** 必须填写却为空的发票。 */
  readonly missing: readonly PurposeAuditItem[];
  /** 因低于门槛而不需要填写的发票。 */
  readonly allowedEmpty: readonly PurposeAuditItem[];
  /** 已经填写了用途的发票数量。 */
  readonly presentCount: number;
}

/**
 * 批量用途审计。
 *
 * 返回三组而非单一布尔：`missing` 是要向用户报的缺口，
 * `allowedEmpty` 是「看着空但合规」的部分，必须一起给出，
 * 否则用户会误以为系统漏报。`presentCount` 用于「共 N 张已填写」。
 */
export function auditInvoices(
  enterpriseId: EnterpriseId,
  invoices: readonly Invoice[],
  obligation: PurposeObligation,
): PurposeAuditResult {
  const missing: PurposeAuditItem[] = [];
  const allowedEmpty: PurposeAuditItem[] = [];
  let presentCount = 0;

  for (const inv of invoices) {
    if (inv.enterpriseId !== enterpriseId) continue;
    const verdict = auditPurpose(inv, obligation);
    const item: PurposeAuditItem = {
      invoiceNo: inv.invoiceNo,
      amountCents: inv.amount.cents,
      verdict,
    };
    switch (verdict) {
      case 'missing':
        missing.push(item);
        break;
      case 'allowed-empty':
        allowedEmpty.push(item);
        break;
      case 'present':
        presentCount += 1;
        break;
    }
  }

  return { missing, allowedEmpty, presentCount };
}

/** 便捷判定：这批发票在该义务下是否全部合规。 */
export function isBatchCompliant(result: PurposeAuditResult): boolean {
  return result.missing.length === 0;
}
