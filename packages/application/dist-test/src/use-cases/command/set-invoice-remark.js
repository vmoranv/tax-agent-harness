import { decideWrite, enterpriseId, InvoiceId, normalizeRemark, parseRequestId, invoiceNo as toInvoiceNo, userId as toUserId, } from '@harness/domain';
/** 控制字符（除换行与制表外的 C0/C1）不应进入业务字段。 */
function hasControlChars(s) {
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(s);
}
/**
 * UC-06 · 修改发票备注。
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
export async function setInvoiceRemark(deps, cmd) {
    const enterprise = enterpriseId(cmd.enterpriseId);
    const no = toInvoiceNo(cmd.invoiceNo);
    const invoiceId = InvoiceId.of(enterprise, no);
    return deps.uow.run(async (tx) => {
        // ① 权限先判 —— 先于存在性检查
        const grant = await tx.grants.find(toUserId(cmd.actor), enterprise);
        const decision = decideWrite(grant, 'remark');
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
        if (hasControlChars(cmd.newRemark)) {
            return {
                kind: 'invalid',
                field: 'newRemark',
                reason: 'control-chars',
                message: '备注里不能包含控制字符',
            };
        }
        let normalized;
        try {
            normalized = normalizeRemark(cmd.newRemark);
        }
        catch {
            return {
                kind: 'invalid',
                field: 'newRemark',
                reason: 'too-long',
                message: '备注内容不符合要求（长度或格式）',
            };
        }
        // 备注**允许清空**：与用途不同，它不是必填项。
        // 空串 / 全空白 → normalizeRemark 归一为 null，此处直接落库而不是报 invalid。
        // 依据：字段说明「空单元格表示未填写」；R002/R003 只把用途列为必填。
        // ⑦ 同值 no-op —— 跨轮幂等靠语义，不靠键
        const before = invoice.remark;
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
        invoice.changeRemark(normalized, decision, parseRequestId(dedupeKey), toUserId(cmd.actor), deps.clock.today());
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
            field: 'remark',
            oldValue: before,
            // 日志的 newValue 是 string，清空记为 ''（与 null 语义等价，便于唯一索引比较）
            newValue: normalized ?? '',
            runId: cmd.runId,
            toolCallId: cmd.toolCallId,
            actor: cmd.actor,
            createdAt: deps.clock.now().toISOString(),
        });
        // ⑩ 回读复核 —— 不相信内存里的对象，重新从存储读
        const rereadAt = deps.clock.now().toISOString();
        const reread = await tx.invoices.findById(invoiceId);
        if (reread === null || reread.remark !== normalized) {
            return {
                kind: 'verify-failed',
                expected: normalized,
                actual: reread?.remark ?? null,
            };
        }
        return {
            kind: 'saved',
            changed: true,
            enterpriseId: enterprise,
            invoiceNo: no,
            before,
            after: reread.remark,
            rereadAt,
        };
    });
}
//# sourceMappingURL=set-invoice-remark.js.map