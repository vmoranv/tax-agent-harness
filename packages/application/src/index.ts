export type { Deps } from './deps.js';
export type {
  ApplicationFacadeLike,
  FacadeDatabase,
  SetPurposeInput,
  SetRemarkInput,
} from './facade.js';
export { createApplicationFacade } from './facade.js';
export type {
  CorrectMemoryCommand,
  CorrectMemoryResult,
  ForgetMemoryCommand,
  ForgetMemoryResult,
  RememberPreferenceCommand,
  RememberPreferenceResult,
} from './use-cases/command/manage-memory.js';
export {
  correctMemory,
  forgetMemory,
  rememberPreference,
} from './use-cases/command/manage-memory.js';
export type {
  SetRuleStatusCommand,
  SetRuleStatusResult,
  UpdateRuleCommand,
  UpdateRuleResult,
} from './use-cases/command/manage-rules.js';
export { setRuleStatus, updateRule } from './use-cases/command/manage-rules.js';
/* --------------------------------- 命令 --------------------------------- */
export type {
  SetInvoicePurposeCommand,
  SetInvoicePurposeResult,
} from './use-cases/command/set-invoice-purpose.js';
export { setInvoicePurpose } from './use-cases/command/set-invoice-purpose.js';
export type {
  SetInvoiceRemarkCommand,
  SetInvoiceRemarkResult,
} from './use-cases/command/set-invoice-remark.js';
export { setInvoiceRemark } from './use-cases/command/set-invoice-remark.js';
export type {
  UpsertTaskCardCommand,
  UpsertTaskCardResult,
} from './use-cases/command/upsert-task-card.js';
export { upsertTaskCard } from './use-cases/command/upsert-task-card.js';
export type { ActorContext, InvoiceLocator, MonthScope } from './use-cases/common.js';
export type {
  ExplainRulesOutcome,
  ExplainRulesQuery,
  ExplainRulesResult,
} from './use-cases/query/explain-rules.js';
export { explainRules } from './use-cases/query/explain-rules.js';
export { findPurposeGaps } from './use-cases/query/find-purpose-gaps.js';
export type { GetInvoiceResult } from './use-cases/query/get-invoice.js';
export { getInvoice } from './use-cases/query/get-invoice.js';
export { memoryView } from './use-cases/query/memory-view.js';
/* --------------------------------- 查询 --------------------------------- */
export { summarizeMonth } from './use-cases/query/summarize-month.js';
