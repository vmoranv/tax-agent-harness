import { decideWrite, enterpriseId, InvoiceId, invoiceRef, normalizePurpose, parseRequestId, invoiceNo as toInvoiceNo, userId as toUserId, } from '@harness/domain';
/** 控制字符（除换行与制表外的 C0/C1）不应进入业务字段。 */
function hasControlChars(s) {
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(s);
}
/**
 * UC-05 · 修改发票用途。
 *
 * 十步顺序**不可调换**（见 docs/spec/06-application-layer.md §5）：
 *  ① 权限先判（不看对象是否存在，避免信息泄漏）
 *  ② 查企业
 *  ③ 查发票
 *  ④ 只读企业拒绝写
 *  ⑤ 字段白名单
 *  ⑥ 内容校验
 *  ⑦ 同值 → changed:false，不写库
 *  ⑧ 乐观锁写入
 *  ⑨ 写日志
 *  ⑩ 回读复核
 *
 * 第 ⑦ 步是跨轮幂等的实现方式：**不靠幂等键，靠语义**。
 */
export async function setInvoicePurpose(deps, cmd) {
    const enterprise = enterpriseId(cmd.enterpriseId);
    const no = toInvoiceNo(cmd.invoiceNo);
    const invoiceId = InvoiceId.of(enterprise, no);
    return deps.uow.run(async (tx) => {
        // ① 权限先判 —— 先于存在性检查
        const grant = await tx.grants.find(toUserId(cmd.actor), enterprise);
        const decision = decideWrite(grant, 'purpose');
        if (!decision.allowed) {
            return {
                kind: 'denied',
                reason: decision.reason,
                message: decision.message,
            };
        }
        // ② 企业存在性
        const ent = await tx.enterprises.findById(enterprise);
        if (ent === null) {
            return { kind: 'not-found', invoiceId: invoiceId.value() };
        }
        // ③ 发票存在性
        const invoice = await tx.invoices.findById(invoiceId);
        if (invoice === null) {
            return { kind: 'not-found', invoiceId: invoiceId.value() };
        }
        // ④⑤ 权限决策已经包含 read-only 与字段白名单，无需重复判定
        // ⑥ 内容校验
        if (hasControlChars(cmd.newPurpose)) {
            return {
                kind: 'invalid',
                field: 'newPurpose',
                reason: 'control-chars',
                message: '用途里不能包含控制字符',
            };
        }
        let normalized;
        try {
            normalized = normalizePurpose(cmd.newPurpose);
        }
        catch {
            return {
                kind: 'invalid',
                field: 'newPurpose',
                reason: 'too-long',
                message: '用途内容不符合要求（长度或格式）',
            };
        }
        if (normalized === null) {
            return {
                kind: 'invalid',
                field: 'newPurpose',
                reason: 'blank',
                message: '用途不能为空或只有空白字符',
            };
        }
        // ⑦ 同值 no-op —— 跨轮幂等靠语义，不靠键
        const before = invoice.purpose;
        if (before === normalized) {
            return {
                kind: 'saved',
                changed: false,
                enterpriseId: enterprise,
                invoiceNo: no,
                before,
                after: before,
                rereadAt: deps.clock.now().toISOString(),
            };
        }
        // ⑧ 乐观锁写入
        const expectedVersion = invoice.version;
        const dedupeKey = cmd.dedupeKey ?? `${cmd.runId}:${cmd.toolCallId}`;
        invoice.changePurpose(normalized, decision, parseRequestId(dedupeKey), toUserId(cmd.actor), deps.clock.today());
        const written = await tx.invoices.save(invoice, expectedVersion);
        if (!written) {
            // 重新读一次拿当前版本号，供调用方决定是否重试
            const latest = await tx.invoices.findById(invoiceId);
            return { kind: 'conflict', currentVersion: latest?.version ?? expectedVersion };
        }
        // ⑨ 写日志（数据库层唯一索引兜底防同轮重复）
        await tx.writeLog.append({
            enterpriseId: enterprise,
            invoiceNo: no,
            field: 'purpose',
            oldValue: before,
            newValue: normalized,
            runId: cmd.runId,
            toolCallId: cmd.toolCallId,
            actor: cmd.actor,
            createdAt: deps.clock.now().toISOString(),
        });
        // ⑩ 回读复核 —— 不相信内存里的对象，重新从存储读
        const rereadAt = deps.clock.now().toISOString();
        const reread = await tx.invoices.findById(invoiceId);
        if (reread === null || reread.purpose !== normalized) {
            return {
                kind: 'verify-failed',
                expected: normalized,
                actual: reread?.purpose ?? null,
            };
        }
        // ⑪ 任务卡自动推进：若该发票在活跃任务卡待办中，迁移到已完成。
        //    在**复核通过之后**做，保证「只有真正写进去的才算完成」。
        await advanceTaskCard(tx, {
            actor: toUserId(cmd.actor),
            enterpriseId: enterprise,
            invoiceId,
            requestId: parseRequestId(dedupeKey),
            verifiedAt: deps.clock.today(),
            observedVersion: reread.version,
        });
        return {
            kind: 'saved',
            changed: true,
            enterpriseId: enterprise,
            invoiceNo: no,
            before,
            after: reread.purpose,
            rereadAt,
        };
    });
}
/**
 * 把已复核通过的写入反映到任务卡（若存在）。
 *
 * 设计约束：
 * - **在事务内**执行，与发票写入同生共死
 * - 发票不在待办中 → 静默跳过（用户可能在做一次性修改，不强行建卡）
 * - 任务卡已被别人改动（乐观锁冲突）→ 不阻断写入，记日志后放弃推进
 */
async function advanceTaskCard(tx, input) {
    const card = await tx.taskCards.findActive(input.actor, input.enterpriseId);
    if (card === null)
        return;
    // 先快照 revision 再变更 —— markCompleted 内部会 revision += 1
    const expectedRevision = card.revision;
    const ref = invoiceRef(input.invoiceId);
    try {
        // markCompleted 内部校验：不在 pending 里就抛错 → 说明是「一次性修改」，
        // 静默忽略即可，这不是错误。
        card.markCompleted(ref, {
            invoiceId: input.invoiceId,
            field: 'purpose',
            requestId: input.requestId,
            verifiedAt: input.verifiedAt,
            observedVersion: input.observedVersion,
        }, input.verifiedAt);
    }
    catch {
        return;
    }
    // 乐观锁失败不阻断发票写入：任务卡只是进度提示，可下次重算
    await tx.taskCards.save(card, expectedRevision).catch(() => false);
}
//# sourceMappingURL=set-invoice-purpose.js.map