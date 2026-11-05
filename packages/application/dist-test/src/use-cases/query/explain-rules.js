import { decideRead, selectApplicableRules, } from '@harness/domain';
/**
 * UC-04 · 解释规则选择。
 *
 * 这是「为什么用了这条、没用那条」的直接证据，也是赛题 R3 的可验证点。
 * 输出会被注入 trace 与回复，演示时可以直接展示。
 */
export async function explainRules(deps, q) {
    return deps.uow.run(async (tx) => {
        const grant = await tx.grants.find(q.actor, q.enterpriseId);
        const read = decideRead(grant);
        if (!read.allowed) {
            return { kind: 'denied', reason: read.reason, message: read.message };
        }
        const candidates = await tx.rules.listCandidates(q.enterpriseId);
        const selection = selectApplicableRules({
            candidates: candidates,
            scope: q.enterpriseId,
            asOfMonth: q.month,
        });
        return {
            kind: 'ok',
            enterpriseId: q.enterpriseId,
            month: q.month,
            applied: selection.selected.map((c) => ({
                code: c.code,
                version: c.version,
                title: c.title,
                scope: c.scopeLabel,
                effectiveFrom: c.effectiveFrom,
                status: 'enabled',
            })),
            excluded: selection.rejected.map((r) => ({
                code: r.code,
                version: r.version,
                reason: r.reason,
                detail: r.detail,
            })),
            rationale: '选择规则时按三重条件过滤：规则状态为启用、适用于本企业（或通用）、' +
                '生效日期不晚于查询期间；同一编号有多版本时取生效日期最新的那条。',
        };
    });
}
//# sourceMappingURL=explain-rules.js.map