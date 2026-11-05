/**
 * 端口层：领域/应用层对外部世界的**唯一**依赖面。
 *
 * 依赖方向（由 dependency-cruiser 强制）：
 *   adapters  →  contracts  （实现这些接口）
 *   plugins   →  contracts  （实现扩展点）
 *   runtime   →  contracts
 *   application → contracts
 *
 * 关键约束：`adapters` 与 `plugins` **不得**依赖 `application`。
 * 因此它们只能实现契约、拿不到用例层，天然无法绕过业务校验。
 */

import type {
  AccessGrant,
  BankTransaction,
  Enterprise,
  EnterpriseId,
  Invoice,
  InvoiceId,
  IsoDate,
  MemoryRecord,
  Money,
  Month,
  RuleCode,
  RuleDocument,
  RuleVersion,
  TaskCard,
  UserAccount,
  UserId,
} from '@harness/domain';

import type {
  AccessLevelDto,
  EnterpriseDto,
  RuleReference,
  TaskCardSnapshotDto,
  TraceRunRecord,
  TraceSummary,
  UserDto,
} from '../dto/index.js';

/* ============================== 台账仓储 ============================== */

export interface InvoiceRepository {
  findById(id: InvoiceId): Promise<Invoice | null>;
  listByMonth(enterpriseId: EnterpriseId, month: Month): Promise<Invoice[]>;
  /** 只返回「用途为空」的发票。**是否必须填**由领域层判定，不在 SQL 里判。 */
  listMissingPurpose(enterpriseId: EnterpriseId, month: Month): Promise<Invoice[]>;
  /**
   * 乐观锁写入。
   * @param expectedVersion 调用方读取时的版本号
   * @returns `true` 写入成功；`false` 版本不符（并发冲突）
   */
  save(invoice: Invoice, expectedVersion: number): Promise<boolean>;
  /** 仅供导入与测试使用。 */
  bulkUpsert(invoices: readonly Invoice[]): Promise<number>;
}

/**
 * 银行流水仓储：**只读**。
 *
 * 故意不提供 `save` / `update` / `delete` 方法 —— 类型层面堵死写入路径。
 * 数据库层另有 `BEFORE UPDATE/DELETE` 触发器作为第二道保险。
 */
export interface BankTransactionRepository {
  listByMonth(enterpriseId: EnterpriseId, month: Month): Promise<BankTransaction[]>;
  /** 只用于导入，不对外暴露给用例层调用之外的地方。 */
  bulkInsert(transactions: readonly BankTransaction[]): Promise<number>;
}

export interface EnterpriseRepository {
  findById(id: EnterpriseId): Promise<Enterprise | null>;
  listAll(): Promise<Enterprise[]>;
  /** 把「甲企业」「乙企业」这类简称解析成编号。 */
  resolveByName(name: string): Promise<Enterprise | null>;
}

export interface UserRepository {
  findById(id: UserId): Promise<UserAccount | null>;
  listAll(): Promise<UserAccount[]>;
}

export interface AccessGrantRepository {
  find(userId: UserId, enterpriseId: EnterpriseId): Promise<AccessGrant | null>;
  listByUser(userId: UserId): Promise<AccessGrant[]>;
}

/* ============================== 规则仓储 ============================== */

export interface RuleRepository {
  find(code: RuleCode, version: RuleVersion): Promise<RuleDocument | null>;
  /** 返回全部版本，由领域层 `selectApplicableRules` 做三重过滤。 */
  listCandidates(scope: EnterpriseId | 'ALL'): Promise<RuleDocument[]>;
  listAll(): Promise<RuleDocument[]>;
  save(doc: RuleDocument): Promise<void>;
  updateStatus(
    code: RuleCode,
    version: RuleVersion,
    status: 'enabled' | 'disabled',
  ): Promise<boolean>;
}

/* ============================== 记忆仓储 ============================== */

export interface TaskCardRepository {
  findActive(userId: UserId, enterpriseId: EnterpriseId): Promise<TaskCard | null>;
  save(card: TaskCard, expectedRevision: number): Promise<boolean>;
  /** 历史卡片（已完成/已放弃），用于「查看记忆」。 */
  listByScope(userId: UserId, enterpriseId: EnterpriseId): Promise<TaskCard[]>;
}

export interface MemoryRecordRepository {
  list(userId: UserId, enterpriseId: EnterpriseId): Promise<MemoryRecord[]>;
  find(userId: UserId, enterpriseId: EnterpriseId, key: string): Promise<MemoryRecord | null>;
  upsert(record: MemoryRecord): Promise<void>;
  delete(userId: UserId, enterpriseId: EnterpriseId, key: string): Promise<boolean>;
}

/* ============================ 幂等 / 写日志 ============================ */

/**
 * 写入日志。
 *
 * 唯一索引 `(enterprise_id, invoice_no, field, new_value, run_id)` 保证
 * 同一轮对同一目标的同一新值只可能落一条 —— 这是幂等的数据库侧兜底。
 */
export interface InvoiceWriteLogEntry {
  readonly enterpriseId: string;
  readonly invoiceNo: string;
  readonly field: 'purpose' | 'remark';
  readonly oldValue: string | null;
  readonly newValue: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly actor: string;
  readonly createdAt: string;
}

export interface InvoiceWriteLogRepository {
  append(entry: InvoiceWriteLogEntry): Promise<void>;
  /** 查本轮是否已写过同一目标同一值。 */
  hasWritten(
    runId: string,
    enterpriseId: string,
    invoiceNo: string,
    field: 'purpose' | 'remark',
    newValue: string,
  ): Promise<boolean>;
  listByRun(runId: string): Promise<InvoiceWriteLogEntry[]>;
}

/* ================================ 会话 ================================ */

export type MessageRole = 'user' | 'assistant';

export interface StoredMessage {
  readonly id: number;
  readonly sessionId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly enterpriseId: string;
  readonly createdAt: string;
  readonly lastActiveAt: string;
}

export interface SessionRepository {
  findOrCreate(userId: UserId, enterpriseId: EnterpriseId, now: IsoDate): Promise<SessionRecord>;
  findById(sessionId: string): Promise<SessionRecord | null>;
  appendMessage(
    sessionId: string,
    role: MessageRole,
    content: string,
    now: IsoDate,
  ): Promise<StoredMessage>;
  listMessages(sessionId: string, limit: number): Promise<StoredMessage[]>;
  touch(sessionId: string, now: IsoDate): Promise<void>;
}

/* ============================== 运行记录 ============================== */

export interface TraceFilter {
  readonly userId?: string;
  readonly enterpriseId?: string;
  readonly limit?: number;
}

export interface TraceRepository {
  save(run: TraceRunRecord): Promise<void>;
  get(runId: string): Promise<TraceRunRecord | null>;
  list(filter: TraceFilter): Promise<TraceSummary[]>;
}

/* ============================== 事务边界 ============================== */

/** 领域事件收集器：用例内发布，事务提交后由上层决定如何消费。 */
export interface DomainEventCollector {
  publish(event: { readonly type: string; readonly [k: string]: unknown }): void;
  drain(): ReadonlyArray<{ readonly type: string; readonly [k: string]: unknown }>;
}

/** 事务内可见的仓储集合。 */
export interface TransactionScope {
  readonly invoices: InvoiceRepository;
  readonly banks: BankTransactionRepository;
  readonly enterprises: EnterpriseRepository;
  readonly users: UserRepository;
  readonly grants: AccessGrantRepository;
  readonly rules: RuleRepository;
  readonly taskCards: TaskCardRepository;
  readonly preferences: MemoryRecordRepository;
  readonly writeLog: InvoiceWriteLogRepository;
  readonly sessions: SessionRepository;
  readonly events: DomainEventCollector;
}

/**
 * 工作单元：**唯一**的事务边界。
 *
 * 约束：`fn` 内只做数据操作，**绝不在事务内 await LLM**。
 */
export interface UnitOfWork {
  run<T>(fn: (tx: TransactionScope) => Promise<T>): Promise<T>;
}

/* ============================ 基础设施端口 ============================ */

export interface Clock {
  now(): Date;
  /** 便于测试固定时间。 */
  today(): IsoDate;
}

export interface IdGenerator {
  next(prefix: string): string;
}

/* ============================== LLM 端口 ============================== */

export interface LlmGateway {
  readonly providerId: string;
  readonly modelId: string;
  /** 返回 AI SDK 的 LanguageModel 实例。类型由 runtime 层收窄。 */
  createModel(): unknown;
}

/* ============================ 便于上层的窄类型 ============================ */

export type {
  AccessLevelDto,
  EnterpriseDto,
  Money,
  Money as Amount,
  RuleReference,
  TaskCardSnapshotDto,
  UserDto,
};
