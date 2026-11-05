/**
 * 内存仓储：供应用层单测使用，零 I/O。
 *
 * 刻意保留与真实实现相同的语义约束：
 * - Invoice 按 `(enterpriseId, invoiceNo)` 复合键存取
 * - 乐观锁版本不符时返回 `false`
 * - 银行流水只能读
 */

import type {
  AccessGrantRepository,
  BankTransactionRepository,
  Clock,
  DomainEventCollector,
  EnterpriseRepository,
  IdGenerator,
  InvoiceRepository,
  InvoiceWriteLogEntry,
  InvoiceWriteLogRepository,
  MemoryRecordRepository,
  MessageRole,
  RuleRepository,
  SessionRecord,
  SessionRepository,
  StoredMessage,
  TaskCardRepository,
  TransactionScope,
  UnitOfWork,
  UserRepository,
} from '@harness/contracts';
import type {
  AccessGrant,
  BankTransaction,
  Enterprise,
  EnterpriseId,
  InvoiceId,
  InvoiceSnapshot,
  IsoDate,
  MemoryRecord,
  Month,
  RuleCode,
  RuleDocument,
  RuleVersion,
  UserAccount,
  UserId,
} from '@harness/domain';
import { Invoice, TaskCard, type TaskCardSnapshot } from '@harness/domain';

function keyOf(e: string, n: string): string {
  return `${e}/${n}`;
}

/**
 * 内存发票仓储。
 *
 * **存快照不存对象引用**：真实仓储每次从数据库行重建聚合；
 * 若这里直接存引用，`changePurpose` 就地改版本号会让乐观锁永远失败。
 */
export class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly store = new Map<string, InvoiceSnapshot>();
  /** 记录 save 被调用次数，供「无权限时不应写」的断言使用。 */
  saveCalls = 0;
  /** 故障注入：设成 true 时，save 后 findById 返回旧值（模拟持久化失败）。 */
  simulateVerifyFailure = false;
  private readonly staleShadow = new Map<string, InvoiceSnapshot>();

  seed(invoices: readonly Invoice[]): void {
    for (const inv of invoices) {
      this.store.set(keyOf(inv.enterpriseId, inv.invoiceNo), inv.snapshot());
    }
  }

  async findById(id: InvoiceId): Promise<Invoice | null> {
    const k = keyOf(id.enterpriseId, id.invoiceNo);
    const snap = this.simulateVerifyFailure
      ? (this.staleShadow.get(k) ?? this.store.get(k))
      : this.store.get(k);
    return snap === undefined ? null : Invoice.rehydrate(snap);
  }

  async listByMonth(e: EnterpriseId, m: Month): Promise<Invoice[]> {
    return [...this.store.values()]
      .map((s) => Invoice.rehydrate(s))
      .filter((i) => i.enterpriseId === e && i.issuedOn.startsWith(m));
  }

  async listMissingPurpose(e: EnterpriseId, m: Month): Promise<Invoice[]> {
    return (await this.listByMonth(e, m)).filter((i) => i.purpose === null);
  }

  async save(invoice: Invoice, expectedVersion: number): Promise<boolean> {
    this.saveCalls += 1;
    const k = keyOf(invoice.enterpriseId, invoice.invoiceNo);
    const current = this.store.get(k);
    if (current === undefined) return false;
    if (current.version !== expectedVersion) return false;
    if (this.simulateVerifyFailure) {
      this.staleShadow.set(k, current);
    }
    this.store.set(k, invoice.snapshot());
    return true;
  }

  async bulkUpsert(invoices: readonly Invoice[]): Promise<number> {
    this.seed(invoices);
    return invoices.length;
  }
}

export class InMemoryBankRepository implements BankTransactionRepository {
  private readonly store: BankTransaction[] = [];

  seed(rows: readonly BankTransaction[]): void {
    this.store.push(...rows);
  }

  async listByMonth(e: EnterpriseId, m: Month): Promise<BankTransaction[]> {
    return this.store.filter((t) => t.id.startsWith(e) && t.occurredOn.startsWith(m));
  }

  async bulkInsert(rows: readonly BankTransaction[]): Promise<number> {
    this.store.push(...rows);
    return rows.length;
  }
}

export class InMemoryEnterpriseRepository implements EnterpriseRepository {
  private readonly store = new Map<string, Enterprise>();

  seed(rows: readonly Enterprise[]): void {
    for (const e of rows) this.store.set(e.id, e);
  }

  async findById(id: EnterpriseId): Promise<Enterprise | null> {
    return this.store.get(id) ?? null;
  }

  async listAll(): Promise<Enterprise[]> {
    return [...this.store.values()];
  }

  async resolveByName(name: string): Promise<Enterprise | null> {
    return (
      [...this.store.values()].find((e) => e.legalName === name || e.aliasesFor().includes(name)) ??
      null
    );
  }
}

export class InMemoryUserRepository implements UserRepository {
  private readonly store = new Map<string, UserAccount>();

  seed(rows: readonly UserAccount[]): void {
    for (const u of rows) this.store.set(u.id, u);
  }

  async findById(id: UserId): Promise<UserAccount | null> {
    return this.store.get(id) ?? null;
  }

  async listAll(): Promise<UserAccount[]> {
    return [...this.store.values()];
  }
}

export class InMemoryGrantRepository implements AccessGrantRepository {
  private readonly store = new Map<string, AccessGrant>();

  seed(rows: ReadonlyArray<{ userId: string; grant: AccessGrant }>): void {
    for (const r of rows) {
      this.store.set(`${r.userId}:${r.grant.enterpriseId}`, r.grant);
    }
  }

  async find(userId: UserId, enterpriseId: EnterpriseId): Promise<AccessGrant | null> {
    return this.store.get(`${userId}:${enterpriseId}`) ?? null;
  }

  async listByUser(userId: UserId): Promise<AccessGrant[]> {
    const prefix = `${userId}:`;
    return [...this.store.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
  }
}

export class InMemoryRuleRepository implements RuleRepository {
  private readonly store = new Map<string, RuleDocument>();

  seed(rows: readonly RuleDocument[]): void {
    for (const r of rows) this.store.set(`${r.code}@${r.version}`, r);
  }

  async find(code: RuleCode, version: RuleVersion): Promise<RuleDocument | null> {
    return this.store.get(`${code}@${version}`) ?? null;
  }

  async listCandidates(scope: EnterpriseId | 'ALL'): Promise<RuleDocument[]> {
    return [...this.store.values()].filter(
      (r) => r.scope.kind === 'global' || r.scope.enterpriseId === scope,
    );
  }

  async listAll(): Promise<RuleDocument[]> {
    return [...this.store.values()];
  }

  async save(doc: RuleDocument): Promise<void> {
    this.store.set(`${doc.code}@${doc.version}`, doc);
  }

  async updateStatus(
    code: RuleCode,
    version: RuleVersion,
    status: 'enabled' | 'disabled',
  ): Promise<boolean> {
    const k = `${code}@${version}`;
    if (!this.store.has(k)) return false;
    void status;
    return true;
  }
}

export class InMemoryTaskCardRepository implements TaskCardRepository {
  /**
   * **存快照而非对象引用**。真实仓储每次从数据库行重建聚合；
   * 若直接存引用，调用方后续 `reconcile` 自增 revision 会污染「已存版本」，
   * 导致乐观锁在下一次保存时永远失败。
   */
  private readonly store = new Map<string, TaskCardSnapshot>();

  async findActive(userId: UserId, enterpriseId: EnterpriseId): Promise<TaskCard | null> {
    const snapshot = this.store.get(`${userId}:${enterpriseId}`);
    if (snapshot === undefined) return null;
    const card = TaskCard.rehydrate(snapshot);
    // 契约是「active」：已完成/已放弃的卡不占唯一索引，也不该被当作进行中任务
    return card.status === 'active' ? card : null;
  }

  async save(card: TaskCard, expectedRevision: number): Promise<boolean> {
    const k = `${card.scope.userId}:${card.scope.enterpriseId}`;
    const current = this.store.get(k);
    // 已完成/已放弃的旧卡不参与乐观锁比对：它不占唯一索引，
    // 新卡可以直接覆盖同一 key。
    const live = current !== undefined && current.status === 'active';
    if (live && current.revision !== expectedRevision) return false;
    this.store.set(k, card.toSnapshot());
    return true;
  }

  async listByScope(userId: UserId, enterpriseId: EnterpriseId): Promise<TaskCard[]> {
    const snapshot = this.store.get(`${userId}:${enterpriseId}`);
    return snapshot === undefined ? [] : [TaskCard.rehydrate(snapshot)];
  }
}

export class InMemoryMemoryRecordRepository implements MemoryRecordRepository {
  private readonly store = new Map<string, MemoryRecord>();

  async list(userId: UserId, enterpriseId: EnterpriseId): Promise<MemoryRecord[]> {
    const prefix = `${userId}:${enterpriseId}:`;
    return [...this.store.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
  }

  async find(
    userId: UserId,
    enterpriseId: EnterpriseId,
    key: string,
  ): Promise<MemoryRecord | null> {
    return this.store.get(`${userId}:${enterpriseId}:${key}`) ?? null;
  }

  async upsert(record: MemoryRecord): Promise<void> {
    this.store.set(`${record.scope.userId}:${record.scope.enterpriseId}:${record.key}`, record);
  }

  async delete(userId: UserId, enterpriseId: EnterpriseId, key: string): Promise<boolean> {
    return this.store.delete(`${userId}:${enterpriseId}:${key}`);
  }
}

export class InMemoryWriteLog implements InvoiceWriteLogRepository {
  readonly entries: InvoiceWriteLogEntry[] = [];

  async append(entry: InvoiceWriteLogEntry): Promise<void> {
    const dup = this.entries.some(
      (e) =>
        e.runId === entry.runId &&
        e.enterpriseId === entry.enterpriseId &&
        e.invoiceNo === entry.invoiceNo &&
        e.field === entry.field &&
        e.newValue === entry.newValue,
    );
    // 模拟数据库唯一索引
    if (dup) throw new Error('UNIQUE constraint failed: invoice_write_log');
    this.entries.push(entry);
  }

  async hasWritten(
    runId: string,
    e: string,
    no: string,
    field: 'purpose' | 'remark',
    newValue: string,
  ): Promise<boolean> {
    return this.entries.some(
      (x) =>
        x.runId === runId &&
        x.enterpriseId === e &&
        x.invoiceNo === no &&
        x.field === field &&
        x.newValue === newValue,
    );
  }

  async listByRun(runId: string): Promise<InvoiceWriteLogEntry[]> {
    return this.entries.filter((e) => e.runId === runId);
  }
}

export class InMemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly messages: StoredMessage[] = [];
  private seq = 0;

  async findOrCreate(
    userId: UserId,
    enterpriseId: EnterpriseId,
    now: string,
  ): Promise<SessionRecord> {
    const existing = [...this.sessions.values()].find(
      (s) => s.userId === userId && s.enterpriseId === enterpriseId,
    );
    if (existing !== undefined) return existing;
    const s: SessionRecord = {
      id: `s${++this.seq}`,
      userId,
      enterpriseId,
      createdAt: now,
      lastActiveAt: now,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  async findById(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async appendMessage(
    sessionId: string,
    role: MessageRole,
    content: string,
    now: string,
  ): Promise<StoredMessage> {
    const m: StoredMessage = {
      id: ++this.seq,
      sessionId,
      role,
      content,
      createdAt: now,
    };
    this.messages.push(m);
    return m;
  }

  async listMessages(sessionId: string, limit: number): Promise<StoredMessage[]> {
    return this.messages.filter((m) => m.sessionId === sessionId).slice(-limit);
  }

  async touch(sessionId: string, now: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s !== undefined) {
      this.sessions.set(sessionId, { ...s, lastActiveAt: now });
    }
  }
}

export class FakeClock implements Clock {
  constructor(private current: Date = new Date('2026-11-03T09:00:00+08:00')) {}

  now(): Date {
    return this.current;
  }

  today(): IsoDate {
    return this.current.toISOString().slice(0, 10) as IsoDate;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(iso: string): void {
    this.current = new Date(iso);
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private seq = 0;

  next(prefix: string): string {
    return `${prefix}_${++this.seq}`;
  }
}

class InMemoryEventCollector implements DomainEventCollector {
  private buffer: Array<{ type: string; [k: string]: unknown }> = [];

  publish(event: { type: string; [k: string]: unknown }): void {
    this.buffer.push(event);
  }

  drain(): ReadonlyArray<{ type: string; [k: string]: unknown }> {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }
}

/** 把各内存仓储装配成一个 UnitOfWork（无事务语义，单测够用）。 */
export class InMemoryUnitOfWork implements UnitOfWork {
  readonly invoices = new InMemoryInvoiceRepository();
  readonly banks = new InMemoryBankRepository();
  readonly enterprises = new InMemoryEnterpriseRepository();
  readonly users = new InMemoryUserRepository();
  readonly grants = new InMemoryGrantRepository();
  readonly rules = new InMemoryRuleRepository();
  readonly taskCards = new InMemoryTaskCardRepository();
  readonly preferences = new InMemoryMemoryRecordRepository();
  readonly writeLog = new InMemoryWriteLog();
  readonly sessions = new InMemorySessionRepository();
  private readonly events = new InMemoryEventCollector();

  async run<T>(fn: (tx: TransactionScope) => Promise<T>): Promise<T> {
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
