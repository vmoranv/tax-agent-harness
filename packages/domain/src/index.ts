/**
 * `@harness/domain` 公共出口。
 *
 * 纯领域层：零 I/O、无框架、无 zod 依赖（zod 由 contracts 层使用）。
 * 所有对外类型与工厂都在此汇总，上层只允许从这里 import。
 */

/* ------------------------------- shared ------------------------------- */

export type { Brand } from './shared/brand.js';

export {
  AccessDeniedError,
  ConcurrencyConflictError,
  DomainError,
  EmptyPurposeError,
  EmptyTextError,
  IdempotencyConflictError,
  InvalidGrantError,
  InvalidIdentifierError,
  InvalidMoneyError,
  InvalidRuleError,
  InvalidTextError,
  InvoiceInvariantError,
  PersistenceVerificationError,
  RuleSelectionAmbiguousError,
  RuleStateError,
  SessionStateError,
  TaskCardRevisionConflictError,
  TaskCardStateError,
  TaskInProgressError,
  TraceStateError,
  UnsupportedRuleError,
  UserDisabledError,
} from './shared/domain-error.js';
export type {
  CorrelationId,
  DomainEvent,
  EventEnvelope,
  RequestId,
} from './shared/domain-event.js';
export { correlationId, parseRequestId } from './shared/domain-event.js';

export type { EnterpriseId, InvoiceNo, RuleCode, RuleVersion, UserId } from './shared/ids.js';
export { enterpriseId, InvoiceId, invoiceNo, ruleCode, ruleVersion, userId } from './shared/ids.js';
export { formatCents, Money, parseCents } from './shared/money.js';
export type { IsoDate, Month } from './shared/month.js';
export {
  isInMonth,
  monthEndExclusive,
  monthStart,
  parseIsoDate,
  parseMonth,
} from './shared/month.js';
export { isBlankText } from './shared/text.js';

/* ------------------------------ identity ------------------------------ */

export type { AccessDecision, DenialReason, MutableField } from './identity/access-policy.js';
export { decideRead, decideWrite, isMutableField } from './identity/access-policy.js';
export type { EnterpriseName, EnterpriseSnapshot } from './identity/enterprise.js';
export { Enterprise, enterpriseName } from './identity/enterprise.js';
/** 兼容别名：`Grant` 与 `AccessGrant` 是同一类型。 */
export type { AccessGrant, AccessGrant as Grant } from './identity/grant.js';
/** `AccessLevel` 同时是类型与运行时常量（三态）。 */
export { AccessLevel, accessGrant, accessRank } from './identity/grant.js';
export type { AccessGranted, AccessRevoked, UserAccountSnapshot } from './identity/user-account.js';
export { UserAccount } from './identity/user-account.js';

/* -------------------------------- ledger ------------------------------- */

export type {
  BankTransactionId,
  BankTransactionSnapshot,
  FlowDirection,
  TransactionNo,
} from './ledger/bank-transaction.js';
export { BankTransaction, bankTransactionId, transactionNo } from './ledger/bank-transaction.js';
export type {
  ChangeOutcome,
  InvoiceChangeEvent,
  InvoiceChangeRecord,
  InvoicePurpose,
  InvoicePurposeChanged,
  InvoiceRemark,
  InvoiceRemarkChanged,
  InvoiceSnapshot,
} from './ledger/invoice.js';
export {
  Invoice,
  MAX_PURPOSE,
  MAX_REMARK,
  normalizePurpose,
  normalizeRemark,
} from './ledger/invoice.js';
export type { BankFlowSummary, InvoiceSummary } from './ledger/month-summary.js';
export { summarizeBank, summarizeInvoices } from './ledger/month-summary.js';

export type { PurposeAuditItem, PurposeAuditResult } from './ledger/purpose-audit.js';
export { auditInvoices, isBatchCompliant } from './ledger/purpose-audit.js';
export type { PurposeObligation, PurposeVerdict } from './ledger/purpose-obligation.js';
export {
  atLeast,
  auditPurpose,
  isBlankPurpose,
  isCompliant,
  PURPOSE_REQUIRED_ALL,
} from './ledger/purpose-obligation.js';

/* ------------------------------- rulebook ------------------------------ */

/** 规则文件里再导出的 PurposeObligation 与本包 ledger 的是同一类型。 */
export type {
  Money as RuleMoney,
  RuleCategory,
  RuleCitation,
  RuleDisabled,
  RuleDocumentSnapshot,
  RuleEnabled,
  RuleScope,
  RuleStatus,
  RuleSuperseded,
} from './rulebook/rule-document.js';
export { compareVersions, formatCitation, RuleDocument } from './rulebook/rule-document.js';

export type {
  RuleRejection,
  RuleRejectionReason,
  RuleSelection,
} from './rulebook/rule-selection.js';
export {
  emptySelection,
  rejectionCounts,
  selectedIds,
  selectionFingerprint,
} from './rulebook/rule-selection.js';

export { ALL_SCOPE, ALL_SCOPE_ID, selectApplicableRules } from './rulebook/rule-selector.js';

/* -------------------------------- memory ------------------------------- */

export type {
  MemoryKind,
  MemoryRecordSnapshot,
  MemoryRecordSuperseded,
  MemoryRecordWritten,
  MemorySource,
} from './memory/memory-record.js';
export { MemoryRecord } from './memory/memory-record.js';
export type {
  InvoiceRef,
  InvoiceRefShape,
  MemoryScope,
  MemoryScopeShape,
} from './memory/memory-scope.js';
export {
  invoiceRef,
  invoiceRefOf,
  invoiceRefParts,
  memoryScope,
  refKey,
  sameScope,
  scopeKey,
} from './memory/memory-scope.js';
export type {
  TaskCardAbandoned,
  TaskCardCompleted,
  TaskCardId,
  TaskCardOpened,
  TaskCardSnapshot,
  TaskItem,
  TaskItemCompleted,
  TaskItemState,
  TaskReconciled,
  TaskStatus,
  WriteConfirmation,
} from './memory/task-card.js';
export { TaskCard, taskCardId } from './memory/task-card.js';

/* ----------------------------- conversation ---------------------------- */

export type {
  Clarification,
  ClarificationReason,
  ClarificationRequested,
  ClarificationResolved,
  ConversationSessionSnapshot,
  EnterpriseSwitched,
  Intent,
  ModelDecision,
  SessionId,
  SessionStarted,
  SlotName,
  SlotState,
  ToolInvocation,
  Turn,
  TurnId,
  TurnRecorded,
  ValidatedDecision,
} from './conversation/conversation-session.js';
export { ConversationSession, sessionId } from './conversation/conversation-session.js';

/* --------------------------------- trace ------------------------------- */

export type {
  EvidenceRef,
  RedactionPolicy,
  RunId,
  StepId,
  StepKind,
  StepStatus,
  TraceRunCompleted,
  TraceRunFailed,
  TraceRunSnapshot,
  TraceRunStarted,
  TraceStep,
  TraceStepInput,
  TraceStepRecorded,
} from './trace/trace-run.js';
export { TraceRun } from './trace/trace-run.js';
