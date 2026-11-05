import { toMoneyDto, } from '@harness/contracts';
import { auditInvoices, decideRead, formatCents, selectApplicableRules, } from '@harness/domain';
/**
 * UC-02 · 检查某企业某月哪些发票缺用途。
 *
 * **全题最大陷阱就在这里**：乙企业 2026-09 有 6 张空用途，但只有 3 张不合规。
 * F001(600.00)、F004(999.99)、F009(486.75) 低于 1000 元门槛，允许为空。
 *
 * 所以结果必须拆成两组：
 *   - `gaps`     —— 必须填但空着，真正要处理的
 *   - `optional` —— 空着但规则允许的
 *
 * 每一项都带 `reason`，把「为什么」写进数据，模型只需转述不需判断。
 */
export async function findPurposeGaps(deps, q) {
    return deps.uow.run(async (tx) => {
        // ① 权限先判
        const grant = await tx.grants.find(q.actor, q.enterpriseId);
        const read = decideRead(grant);
        if (!read.allowed) {
            return {
                kind: 'denied',
                enterpriseId: q.enterpriseId,
                reason: read.reason,
                message: read.message,
            };
        }
        const enterprise = await tx.enterprises.findById(q.enterpriseId);
        if (enterprise === null) {
            return {
                kind: 'denied',
                enterpriseId: q.enterpriseId,
                reason: 'enterprise_not_accessible',
                message: '找不到该企业，或你无权访问',
            };
        }
        const enterpriseDto = {
            id: enterprise.id,
            fullName: enterprise.legalName,
            shortName: enterprise.aliasesFor()[0] ?? enterprise.legalName,
        };
        // ② 只查「用途为空」的候选；是否必须填由领域层按规则判
        const [invoices, candidates] = await Promise.all([
            tx.invoices.listByMonth(q.enterpriseId, q.month),
            tx.rules.listCandidates(q.enterpriseId),
        ]);
        // ③ 选出本期适用的用途规则
        const selection = selectApplicableRules({
            candidates: candidates,
            scope: q.enterpriseId,
            asOfMonth: q.month,
            neededCategories: ['purpose-requirement'],
        });
        const citation = selection.selected[0];
        // RuleCitation 不含可执行谓词，需回查 RuleDocument
        const purposeRule = citation === undefined
            ? null
            : (candidates.find((r) => r.code === citation.code && r.version === citation.version) ??
                null);
        if (purposeRule === null || purposeRule.obligation === null) {
            return {
                kind: 'no-rule',
                enterprise: enterpriseDto,
                month: q.month,
                reason: 'no_applicable_purpose_rule',
                message: `没有找到 ${q.month} 适用于该企业的用途规则，无法判定缺项。`,
            };
        }
        const obligation = purposeRule.obligation;
        // ④ 领域负责判定，应用层只做分组与文案
        const audit = auditInvoices(q.enterpriseId, invoices, obligation);
        const ruleDto = {
            code: purposeRule.code,
            version: purposeRule.version,
            title: purposeRule.title,
            scope: scopeLabelOf(purposeRule),
            effectiveFrom: purposeRule.effectiveFrom,
            status: 'enabled',
        };
        const gaps = [];
        const optional = [];
        const byNo = new Map(invoices.map((i) => [i.invoiceNo, i]));
        for (const item of audit.missing) {
            const inv = byNo.get(item.invoiceNo);
            if (inv === undefined)
                continue; // 审计项一定来自同一批发票，防御性跳过
            gaps.push(toGapItem(inv, requirementReason(obligation)));
        }
        for (const item of audit.allowedEmpty) {
            const inv = byNo.get(item.invoiceNo);
            if (inv === undefined)
                continue;
            optional.push(toGapItem(inv, exemptionReason(obligation, inv.amount.cents)));
        }
        return {
            kind: 'ok',
            enterprise: enterpriseDto,
            month: q.month,
            rule: ruleDto,
            gaps,
            optional,
            totalInvoices: invoices.length,
        };
    });
}
/* ------------------------------ 内部辅助 ------------------------------ */
function toGapItem(inv, reason) {
    return {
        invoiceNo: inv.invoiceNo,
        issuedOn: inv.issuedOn,
        sellerName: inv.sellerName,
        itemName: inv.itemName,
        amount: toMoneyDto(inv.amount),
        reason,
    };
}
function scopeLabelOf(doc) {
    return doc.scope.kind === 'global' ? '通用' : doc.scope.enterpriseId;
}
/** 「为什么必须填」。 */
function requirementReason(ob) {
    switch (ob.kind) {
        case 'purpose_required_all':
            return '该规则要求每张发票都填写用途，不设金额门槛';
        case 'purpose_required_at_least':
            return `该规则要求单张发票金额大于或等于 ${formatCents(ob.thresholdInclTax.cents)} 元时必须填写用途`;
    }
}
/** 「为什么可以不填」。 */
function exemptionReason(ob, amountCents) {
    switch (ob.kind) {
        case 'purpose_required_all':
            // 全量必填下不存在 allowed-empty，理论不可达
            return '该规则下所有发票都必须填写用途';
        case 'purpose_required_at_least':
            return `金额 ${formatCents(amountCents)} 元低于 ${formatCents(ob.thresholdInclTax.cents)} 元门槛，可以不填`;
    }
}
//# sourceMappingURL=find-purpose-gaps.js.map