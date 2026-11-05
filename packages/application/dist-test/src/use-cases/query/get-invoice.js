import { toMoneyDto } from '@harness/contracts';
import { auditPurpose, decideRead, InvoiceId, selectApplicableRules, } from '@harness/domain';
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
export async function getInvoice(deps, q) {
    const enterprise = q.enterpriseId;
    const invoiceId = InvoiceId.of(enterprise, q.invoiceNo);
    return deps.uow.run(async (tx) => {
        // ① 权限先判
        const grant = await tx.grants.find(q.actor, enterprise);
        const read = decideRead(grant);
        if (!read.allowed) {
            return { kind: 'denied', reason: read.reason, message: read.message };
        }
        // ② 复合键取票 —— 企业号是键的一部分，跨企业读取天然为空
        const invoice = await tx.invoices.findById(invoiceId);
        if (invoice === null) {
            return { kind: 'not-found', invoiceId: invoiceId.value() };
        }
        // ③ 取该月适用规则，才能判定用途合规状态
        const month = invoice.issuedOn.slice(0, 7);
        const candidates = await tx.rules.listCandidates(enterprise);
        const selection = selectApplicableRules({
            candidates,
            scope: enterprise,
            asOfMonth: month,
            neededCategories: ['purpose-requirement'],
            at: deps.clock.today(),
        });
        // RuleCitation 不含可执行谓词，须回查 RuleDocument 才能拿到 obligation
        const citation = selection.selected[0];
        const purposeRule = citation === undefined
            ? null
            : (candidates.find((r) => r.code === citation.code && r.version === citation.version) ?? null);
        let purposeStatus;
        if (purposeRule === null || purposeRule.obligation === null) {
            // 没有适用规则时不能把「未填」当成「缺项」
            purposeStatus = invoice.purpose === null ? 'not-evaluated' : 'filled';
        }
        else {
            const verdict = auditPurpose(invoice, purposeRule.obligation);
            purposeStatus =
                verdict === 'present' ? 'filled' : verdict === 'missing' ? 'missing' : 'allowed-empty';
        }
        return {
            kind: 'ok',
            invoice: {
                enterpriseId: invoice.enterpriseId,
                invoiceNo: invoice.invoiceNo,
                issuedOn: invoice.issuedOn,
                sellerName: invoice.sellerName,
                itemName: invoice.itemName,
                amount: toMoneyDto(invoice.amount),
                purpose: invoice.purpose,
                remark: invoice.remark,
                purposeStatus,
            },
            purposeRule: purposeRule === null
                ? null
                : {
                    code: purposeRule.code,
                    version: purposeRule.version,
                    title: purposeRule.title,
                },
        };
    });
}
//# sourceMappingURL=get-invoice.js.map