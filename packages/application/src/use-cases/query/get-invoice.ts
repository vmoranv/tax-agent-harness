import type { DenialReasonDto, InvoicePurposeStatus, InvoiceView } from '@harness/contracts';
import { toMoneyDto } from '@harness/contracts';
import {
  auditPurpose,
  decideRead,
  type EnterpriseId,
  type Invoice,
  InvoiceId,
  type Month,
  type PurposeObligation,
  type RuleDocument,
  selectApplicableRules,
  type UserId,
} from '@harness/domain';
import type { Deps } from '../../deps.js';
import type { InvoiceLocator } from '../common.js';

export type GetInvoiceResult =
  | {
      readonly kind: 'ok';
      readonly invoice: InvoiceView;
      /** 本次判定的依据规则；该月无适用用途规则时为 null。 */
      readonly purposeRule: { code: string; version: string; title: string } | null;
    }
  | { readonly kind: 'denied'; readonly reason: DenialReasonDto; readonly message: string }
  | { readonly kind: 'not-found'; readonly invoiceId: string };

/**
 * UC-03 · 查单张发票。
 *
 * 三条关键约束：
 *
 * ① **复合键定位**。`(enterpriseId, invoiceNo)` 才能唯一确定一张票 ——
 *    C001/F001 与 C002/F001 是两张完全不同的发票。
 * ② **权限先于存在性**。无权限必须返回 `denied` 而非 `not-found`，
 *    否则可以通过「不存在」与「无权」的差异探测其他企业的数据。
 * ③ **purposeStatus 需要规则**。要判断「缺用途」还是「允许为空」，
 *    必须取该企业该月的适用规则；取不到时给 `not-evaluated` 而不是瞎猜。
 */
export async function getInvoice(deps: Deps, q: InvoiceLocator): Promise<GetInvoiceResult> {
  const enterprise = q.enterpriseId as EnterpriseId;
  const invoiceId = InvoiceId.of(enterprise as string, q.invoiceNo);

  return deps.uow.run(async (tx) => {
    // ① 权限先判
    const grant = await tx.grants.find(q.actor as UserId, enterprise);
    const read = decideRead(grant);
    if (!read.allowed) {
      return { kind: 'denied', reason: read.reason as DenialReasonDto, message: read.message };
    }

    // ② 复合键取票 —— 企业号是键的一部分，跨企业读取天然为空
    const invoice: Invoice | null = await tx.invoices.findById(invoiceId);
    if (invoice === null) {
      return { kind: 'not-found', invoiceId: invoiceId.value() };
    }

    // ③ 取该月适用规则，才能判定用途合规状态
    const month = invoice.issuedOn.slice(0, 7) as Month;
    const candidates: readonly RuleDocument[] = await tx.rules.listCandidates(enterprise);
    const selection = selectApplicableRules({
      candidates,
      scope: enterprise,
      asOfMonth: month,
      neededCategories: ['purpose-requirement'],
      at: deps.clock.today(),
    });

    // RuleCitation 不含可执行谓词，须回查 RuleDocument 才能拿到 obligation
    const citation = selection.selected[0];
    const purposeRule: RuleDocument | null =
      citation === undefined
        ? null
        : ((candidates as RuleDocument[]).find(
            (r) => r.code === citation.code && r.version === citation.version,
          ) ?? null);

    let purposeStatus: InvoicePurposeStatus;
    if (purposeRule === null || purposeRule.obligation === null) {
      // 没有适用规则时不能把「未填」当成「缺项」
      purposeStatus = invoice.purpose === null ? 'not-evaluated' : 'filled';
    } else {
      const verdict = auditPurpose(invoice, purposeRule.obligation as PurposeObligation);
      purposeStatus =
        verdict === 'present' ? 'filled' : verdict === 'missing' ? 'missing' : 'allowed-empty';
    }

    return {
      kind: 'ok',
      invoice: {
        enterpriseId: invoice.enterpriseId as string,
        invoiceNo: invoice.invoiceNo as string,
        issuedOn: invoice.issuedOn as string,
        sellerName: invoice.sellerName,
        itemName: invoice.itemName,
        amount: toMoneyDto(invoice.amount),
        purpose: invoice.purpose,
        remark: invoice.remark,
        purposeStatus,
      },
      purposeRule:
        purposeRule === null
          ? null
          : {
              code: purposeRule.code as string,
              version: purposeRule.version as string,
              title: purposeRule.title,
            },
    };
  });
}
