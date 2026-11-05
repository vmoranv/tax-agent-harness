import { AccessDeniedError, decideRead } from '@harness/domain';
/**
 * UC-10 · 查看记忆。
 *
 * 返回「未完成任务卡 + 长期偏好」两段。
 * **空不是错误**：没有记忆时返回 `null` / 空数组，让模型能自然说「没有进行中的任务」，
 * 而不是收到一个错误后胡编。
 *
 * 隔离由 scope 保证：查询条件恒为 `(actor, enterpriseId)`，
 * 不会跨用户、跨企业召回。
 */
export async function memoryView(deps, q) {
    const enterprise = q.enterpriseId;
    const actor = q.actor;
    return deps.uow.run(async (tx) => {
        const grant = await tx.grants.find(actor, enterprise);
        const read = decideRead(grant);
        if (!read.allowed) {
            // 无权访问时返回空记忆而不是抛错：调用方据 read.reason 决定怎么措辞
            throw new AccessDeniedError(read.reason, read.message);
        }
        const [card, preferences] = await Promise.all([
            tx.taskCards.findActive(actor, enterprise),
            tx.preferences.list(actor, enterprise),
        ]);
        return {
            taskCard: card === null
                ? null
                : {
                    userId: card.scope.userId,
                    enterpriseId: card.scope.enterpriseId,
                    month: card.month,
                    state: card.status,
                    pending: card.pending.map((i) => ({ invoiceNo: i.ref.invoiceNo })),
                    completed: card.completed.map((i) => ({
                        invoiceNo: i.ref.invoiceNo,
                    })),
                    note: card.note,
                    revision: card.revision,
                    updatedAt: card.updatedAt,
                },
            preferences: preferences.map((p) => ({
                userId: p.scope.userId,
                enterpriseId: p.scope.enterpriseId,
                key: p.key,
                value: p.value,
                updatedAt: p.updatedAt,
            })),
        };
    });
}
//# sourceMappingURL=memory-view.js.map