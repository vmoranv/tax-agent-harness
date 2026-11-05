import { decideRead, invoiceRefParts, } from '@harness/domain';
function toGapItem(no) {
    return { invoiceNo: no };
}
function toDto(card) {
    return {
        userId: card.scope.userId,
        enterpriseId: card.scope.enterpriseId,
        month: card.month,
        state: card.status,
        pending: card.pending.map((i) => toGapItem(i.ref.invoiceNo)),
        completed: card.completed.map((i) => toGapItem(i.ref.invoiceNo)),
        note: card.note,
        revision: card.revision,
        updatedAt: card.updatedAt,
    };
}
/**
 * UC-07 · 保存任务进度。
 *
 * 两条硬约束（基础要求 2）：
 *
 * ① **每用户每企业至多一个未完成任务**。已有 active 卡时若要开新月份的卡，
 *    必须先完成或放弃旧的 —— 这里返回 `already-open` 而不是静默覆盖，
 *    因为静默覆盖会让用户丢掉上一轮的工作。
 * ② **记忆按 (user, enterprise) 隔离**。卡片的 scope 来自入参，不从别处推断。
 *
 * 与 `findPurposeGaps` 的关系：调用方先查缺项，再把结果传进来。
 * 本用例不自己算缺项 —— 「判定」与「记账」分开，避免两处逻辑漂移。
 */
export async function upsertTaskCard(deps, cmd) {
    const enterprise = cmd.enterpriseId;
    return deps.uow.run(async (tx) => {
        const grant = await tx.grants.find(cmd.actor, enterprise);
        const read = decideRead(grant);
        if (!read.allowed) {
            return { kind: 'denied', reason: read.reason, message: read.message };
        }
        const now = deps.clock.today();
        const refs = cmd.missingNow.map((no) => invoiceRefParts(enterprise, no));
        const existing = await tx.taskCards.findActive(cmd.actor, enterprise);
        const openNew = async () => {
            const { card, event } = (await import('@harness/domain')).TaskCard.open({ userId: cmd.actor, enterpriseId: enterprise }, cmd.month, refs, now);
            tx.events.publish({ ...event });
            const ok = await tx.taskCards.save(card, card.revision);
            if (!ok) {
                return { kind: 'conflict', currentRevision: card.revision, reason: 'revision' };
            }
            return {
                kind: 'saved',
                taskCard: toDto(card),
                revision: card.revision,
                added: refs.map((r) => r.invoiceNo),
                removed: [],
            };
        };
        // ① 没有 active 卡 → 直接开新卡。
        //    已完成/已放弃的旧卡不占唯一索引（`findActive` 本就查不到它们），
        //    因此这里无需再判断旧卡状态。
        if (existing === null) {
            return openNew();
        }
        // ② 已有一张 active 卡，但属于**另一个月份** → 拒绝，不静默覆盖
        if (existing.month !== cmd.month) {
            return {
                kind: 'conflict',
                currentRevision: existing.revision,
                reason: 'already-open',
            };
        }
        // ③ 乐观锁
        const expected = cmd.expectedRevision ?? existing.revision;
        if (expected !== existing.revision) {
            return { kind: 'conflict', currentRevision: existing.revision, reason: 'revision' };
        }
        // ⑤ 对账：把本次检查结果同步到卡片
        const before = new Set(existing.pending.map((i) => i.ref.invoiceNo));
        const reconciled = existing.reconcile(refs, now);
        const after = new Set(existing.pending.map((i) => i.ref.invoiceNo));
        const ok = await tx.taskCards.save(existing, expected);
        if (!ok) {
            const latest = await tx.taskCards.findActive(cmd.actor, enterprise);
            return {
                kind: 'conflict',
                currentRevision: latest?.revision ?? expected,
                reason: 'revision',
            };
        }
        tx.events.publish({ ...reconciled });
        return {
            kind: 'saved',
            taskCard: toDto(existing),
            revision: existing.revision,
            added: [...after].filter((n) => !before.has(n)),
            removed: [...before].filter((n) => !after.has(n)),
        };
    });
}
//# sourceMappingURL=upsert-task-card.js.map