/**
 * 内存仓储：供应用层单测使用，零 I/O。
 *
 * 刻意保留与真实实现相同的语义约束：
 * - Invoice 按 `(enterpriseId, invoiceNo)` 复合键存取
 * - 乐观锁版本不符时返回 `false`
 * - 银行流水只能读
 */
import { Invoice, TaskCard } from '@harness/domain';
function keyOf(e, n) {
    return `${e}/${n}`;
}
/**
 * 内存发票仓储。
 *
 * **存快照不存对象引用**：真实仓储每次从数据库行重建聚合；
 * 若这里直接存引用，`changePurpose` 就地改版本号会让乐观锁永远失败。
 */
export class InMemoryInvoiceRepository {
    store = new Map();
    /** 记录 save 被调用次数，供「无权限时不应写」的断言使用。 */
    saveCalls = 0;
    /** 故障注入：设成 true 时，save 后 findById 返回旧值（模拟持久化失败）。 */
    simulateVerifyFailure = false;
    staleShadow = new Map();
    seed(invoices) {
        for (const inv of invoices) {
            this.store.set(keyOf(inv.enterpriseId, inv.invoiceNo), inv.snapshot());
        }
    }
    async findById(id) {
        const k = keyOf(id.enterpriseId, id.invoiceNo);
        const snap = this.simulateVerifyFailure
            ? (this.staleShadow.get(k) ?? this.store.get(k))
            : this.store.get(k);
        return snap === undefined ? null : Invoice.rehydrate(snap);
    }
    async listByMonth(e, m) {
        return [...this.store.values()]
            .map((s) => Invoice.rehydrate(s))
            .filter((i) => i.enterpriseId === e && i.issuedOn.startsWith(m));
    }
    async listMissingPurpose(e, m) {
        return (await this.listByMonth(e, m)).filter((i) => i.purpose === null);
    }
    async save(invoice, expectedVersion) {
        this.saveCalls += 1;
        const k = keyOf(invoice.enterpriseId, invoice.invoiceNo);
        const current = this.store.get(k);
        if (current === undefined)
            return false;
        if (current.version !== expectedVersion)
            return false;
        if (this.simulateVerifyFailure) {
            this.staleShadow.set(k, current);
        }
        this.store.set(k, invoice.snapshot());
        return true;
    }
    async bulkUpsert(invoices) {
        this.seed(invoices);
        return invoices.length;
    }
}
export class InMemoryBankRepository {
    store = [];
    seed(rows) {
        this.store.push(...rows);
    }
    async listByMonth(e, m) {
        return this.store.filter((t) => t.id.startsWith(e) && t.occurredOn.startsWith(m));
    }
    async bulkInsert(rows) {
        this.store.push(...rows);
        return rows.length;
    }
}
export class InMemoryEnterpriseRepository {
    store = new Map();
    seed(rows) {
        for (const e of rows)
            this.store.set(e.id, e);
    }
    async findById(id) {
        return this.store.get(id) ?? null;
    }
    async listAll() {
        return [...this.store.values()];
    }
    async resolveByName(name) {
        return ([...this.store.values()].find((e) => e.legalName === name || e.aliasesFor().includes(name)) ??
            null);
    }
}
export class InMemoryUserRepository {
    store = new Map();
    seed(rows) {
        for (const u of rows)
            this.store.set(u.id, u);
    }
    async findById(id) {
        return this.store.get(id) ?? null;
    }
    async listAll() {
        return [...this.store.values()];
    }
}
export class InMemoryGrantRepository {
    store = new Map();
    seed(rows) {
        for (const r of rows) {
            this.store.set(`${r.userId}:${r.grant.enterpriseId}`, r.grant);
        }
    }
    async find(userId, enterpriseId) {
        return this.store.get(`${userId}:${enterpriseId}`) ?? null;
    }
    async listByUser(userId) {
        const prefix = `${userId}:`;
        return [...this.store.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    }
}
export class InMemoryRuleRepository {
    store = new Map();
    seed(rows) {
        for (const r of rows)
            this.store.set(`${r.code}@${r.version}`, r);
    }
    async find(code, version) {
        return this.store.get(`${code}@${version}`) ?? null;
    }
    async listCandidates(scope) {
        return [...this.store.values()].filter((r) => r.scope.kind === 'global' || r.scope.enterpriseId === scope);
    }
    async listAll() {
        return [...this.store.values()];
    }
    async save(doc) {
        this.store.set(`${doc.code}@${doc.version}`, doc);
    }
    async updateStatus(code, version, status) {
        const k = `${code}@${version}`;
        if (!this.store.has(k))
            return false;
        void status;
        return true;
    }
}
export class InMemoryTaskCardRepository {
    /**
     * **存快照而非对象引用**。真实仓储每次从数据库行重建聚合；
     * 若直接存引用，调用方后续 `reconcile` 自增 revision 会污染「已存版本」，
     * 导致乐观锁在下一次保存时永远失败。
     */
    store = new Map();
    async findActive(userId, enterpriseId) {
        const snapshot = this.store.get(`${userId}:${enterpriseId}`);
        if (snapshot === undefined)
            return null;
        const card = TaskCard.rehydrate(snapshot);
        // 契约是「active」：已完成/已放弃的卡不占唯一索引，也不该被当作进行中任务
        return card.status === 'active' ? card : null;
    }
    async save(card, expectedRevision) {
        const k = `${card.scope.userId}:${card.scope.enterpriseId}`;
        const current = this.store.get(k);
        // 已完成/已放弃的旧卡不参与乐观锁比对：它不占唯一索引，
        // 新卡可以直接覆盖同一 key。
        const live = current !== undefined && current.status === 'active';
        if (live && current.revision !== expectedRevision)
            return false;
        this.store.set(k, card.toSnapshot());
        return true;
    }
    async listByScope(userId, enterpriseId) {
        const snapshot = this.store.get(`${userId}:${enterpriseId}`);
        return snapshot === undefined ? [] : [TaskCard.rehydrate(snapshot)];
    }
}
export class InMemoryMemoryRecordRepository {
    store = new Map();
    async list(userId, enterpriseId) {
        const prefix = `${userId}:${enterpriseId}:`;
        return [...this.store.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    }
    async find(userId, enterpriseId, key) {
        return this.store.get(`${userId}:${enterpriseId}:${key}`) ?? null;
    }
    async upsert(record) {
        this.store.set(`${record.scope.userId}:${record.scope.enterpriseId}:${record.key}`, record);
    }
    async delete(userId, enterpriseId, key) {
        return this.store.delete(`${userId}:${enterpriseId}:${key}`);
    }
}
export class InMemoryWriteLog {
    entries = [];
    async append(entry) {
        const dup = this.entries.some((e) => e.runId === entry.runId &&
            e.enterpriseId === entry.enterpriseId &&
            e.invoiceNo === entry.invoiceNo &&
            e.field === entry.field &&
            e.newValue === entry.newValue);
        // 模拟数据库唯一索引
        if (dup)
            throw new Error('UNIQUE constraint failed: invoice_write_log');
        this.entries.push(entry);
    }
    async hasWritten(runId, e, no, field, newValue) {
        return this.entries.some((x) => x.runId === runId &&
            x.enterpriseId === e &&
            x.invoiceNo === no &&
            x.field === field &&
            x.newValue === newValue);
    }
    async listByRun(runId) {
        return this.entries.filter((e) => e.runId === runId);
    }
}
export class InMemorySessionRepository {
    sessions = new Map();
    messages = [];
    seq = 0;
    async findOrCreate(userId, enterpriseId, now) {
        const existing = [...this.sessions.values()].find((s) => s.userId === userId && s.enterpriseId === enterpriseId);
        if (existing !== undefined)
            return existing;
        const s = {
            id: `s${++this.seq}`,
            userId,
            enterpriseId,
            createdAt: now,
            lastActiveAt: now,
        };
        this.sessions.set(s.id, s);
        return s;
    }
    async findById(sessionId) {
        return this.sessions.get(sessionId) ?? null;
    }
    async appendMessage(sessionId, role, content, now) {
        const m = {
            id: ++this.seq,
            sessionId,
            role,
            content,
            createdAt: now,
        };
        this.messages.push(m);
        return m;
    }
    async listMessages(sessionId, limit) {
        return this.messages.filter((m) => m.sessionId === sessionId).slice(-limit);
    }
    async touch(sessionId, now) {
        const s = this.sessions.get(sessionId);
        if (s !== undefined) {
            this.sessions.set(sessionId, { ...s, lastActiveAt: now });
        }
    }
}
export class FakeClock {
    current;
    constructor(current = new Date('2026-11-03T09:00:00+08:00')) {
        this.current = current;
    }
    now() {
        return this.current;
    }
    today() {
        return this.current.toISOString().slice(0, 10);
    }
    advance(ms) {
        this.current = new Date(this.current.getTime() + ms);
    }
    set(iso) {
        this.current = new Date(iso);
    }
}
export class SequentialIdGenerator {
    seq = 0;
    next(prefix) {
        return `${prefix}_${++this.seq}`;
    }
}
class InMemoryEventCollector {
    buffer = [];
    publish(event) {
        this.buffer.push(event);
    }
    drain() {
        const out = this.buffer;
        this.buffer = [];
        return out;
    }
}
/** 把各内存仓储装配成一个 UnitOfWork（无事务语义，单测够用）。 */
export class InMemoryUnitOfWork {
    invoices = new InMemoryInvoiceRepository();
    banks = new InMemoryBankRepository();
    enterprises = new InMemoryEnterpriseRepository();
    users = new InMemoryUserRepository();
    grants = new InMemoryGrantRepository();
    rules = new InMemoryRuleRepository();
    taskCards = new InMemoryTaskCardRepository();
    preferences = new InMemoryMemoryRecordRepository();
    writeLog = new InMemoryWriteLog();
    sessions = new InMemorySessionRepository();
    events = new InMemoryEventCollector();
    async run(fn) {
        return fn({
            invoices: this.invoices,
            banks: this.banks,
            enterprises: this.enterprises,
            users: this.users,
            grants: this.grants,
            rules: this.rules,
            taskCards: this.taskCards,
            preferences: this.preferences,
            writeLog: this.writeLog,
            sessions: this.sessions,
            events: this.events,
        });
    }
}
//# sourceMappingURL=in-memory.js.map