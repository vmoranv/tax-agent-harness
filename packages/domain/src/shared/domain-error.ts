/**
 * 领域异常基类与全部子类。
 *
 * 约定：
 * - 每个子类带一个稳定的 SCREAMING_SNAKE `code`，供上层映射为工具错误码；
 * - `details` 只放可安全序列化的诊断信息，不放实体快照；
 * - `name` 取实际类名，便于日志与 trace 直接读取。
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/* ------------------------------------------------------------------ */
/* 共享内核                                                            */
/* ------------------------------------------------------------------ */

/** 金额无法解析（格式非法、负数、超过两位小数）。 */
export class InvalidMoneyError extends DomainError {
  override readonly code = 'INVALID_MONEY';
}

/** 标识符不符合该类型的形态约束（如 EnterpriseId 应形如 C001）。 */
export class InvalidIdentifierError extends DomainError {
  override readonly code = 'INVALID_IDENTIFIER';

  constructor(kind: string, raw: string, hint?: string) {
    super(
      hint === undefined
        ? `标识符 ${kind} 不合法: ${JSON.stringify(raw)}`
        : `标识符 ${kind} 不合法: ${JSON.stringify(raw)}（${hint}）`,
      { kind, raw, hint },
    );
  }
}

/** 文本字段为空或全空白。 */
export class EmptyTextError extends DomainError {
  override readonly code = 'EMPTY_TEXT';
}

/** 文本字段超长或含控制字符。 */
export class InvalidTextError extends DomainError {
  override readonly code = 'INVALID_TEXT';
}

/** 乐观锁版本不匹配。 */
export class ConcurrencyConflictError extends DomainError {
  override readonly code = 'CONCURRENCY_CONFLICT';
}

/** 同一 requestId 携带了不同的写入内容。 */
export class IdempotencyConflictError extends DomainError {
  override readonly code = 'IDEMPOTENCY_CONFLICT';
}

/** 写入后回读不一致。 */
export class PersistenceVerificationError extends DomainError {
  override readonly code = 'PERSISTENCE_VERIFICATION_FAILED';
}

/* ------------------------------------------------------------------ */
/* Identity & Access                                                   */
/* ------------------------------------------------------------------ */

/** 访问被拒绝。`reason` 与 AccessDecision 的 DenialReason 对齐。 */
export class AccessDeniedError extends DomainError {
  override readonly code = 'IAM_ACCESS_DENIED';

  constructor(reason: string, message: string) {
    super(message, { reason });
  }
}

/** 用户已停用，不能执行写操作。 */
export class UserDisabledError extends DomainError {
  override readonly code = 'IAM_USER_DISABLED';
}

/** 授权记录本身非法（等级未知、企业与用户缺失等）。 */
export class InvalidGrantError extends DomainError {
  override readonly code = 'IAM_INVALID_GRANT';
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

/** 用途为空：在「必须填写用途」的场景下拒绝写入空值。 */
export class EmptyPurposeError extends DomainError {
  override readonly code = 'EMPTY_PURPOSE';
}

/** 发票不变量被破坏（只读字段试图变更、企业不一致等）。 */
export class InvoiceInvariantError extends DomainError {
  override readonly code = 'INVOICE_INVARIANT_VIOLATION';
}

/* ------------------------------------------------------------------ */
/* Rulebook                                                            */
/* ------------------------------------------------------------------ */

/** 规则的用途义务类型未知：fail closed。 */
export class UnsupportedRuleError extends DomainError {
  override readonly code = 'UNSUPPORTED_RULE';
}

/** 同一 code 在同一生效点上出现多条，无法唯一确定。 */
export class RuleSelectionAmbiguousError extends DomainError {
  override readonly code = 'RULE_SELECTION_AMBIGUOUS';
}

/** 规则文档自身字段非法。 */
export class InvalidRuleError extends DomainError {
  override readonly code = 'INVALID_RULE';
}

/** 规则状态迁移非法（如重复停用）。 */
export class RuleStateError extends DomainError {
  override readonly code = 'INVALID_RULE_TRANSITION';
}

/* ------------------------------------------------------------------ */
/* Memory                                                              */
/* ------------------------------------------------------------------ */

/** 任务卡状态迁移非法。 */
export class TaskCardStateError extends DomainError {
  override readonly code = 'INVALID_TASK_TRANSITION';
}

/** 任务卡 revision 乐观锁冲突。 */
export class TaskCardRevisionConflictError extends DomainError {
  override readonly code = 'TASK_CARD_REVISION_CONFLICT';
}

/** 已有进行中的任务，不能再开启新任务。 */
export class TaskInProgressError extends DomainError {
  override readonly code = 'TASK_IN_PROGRESS';
}

/* ------------------------------------------------------------------ */
/* Conversation / Trace                                                */
/* ------------------------------------------------------------------ */

/** 会话状态迁移非法（如在已关闭会话上追加轮次）。 */
export class SessionStateError extends DomainError {
  override readonly code = 'INVALID_SESSION_STATE';
}

/** 追踪记录状态迁移非法（如未开始就完成）。 */
export class TraceStateError extends DomainError {
  override readonly code = 'INVALID_TRACE_STATE';
}
