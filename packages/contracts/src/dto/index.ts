/**
 * DTO 层：跨进程/跨层的**纯数据**。
 *
 * 铁律：
 * 1. 金额一律 `MoneyDto`，`cents` 是**字符串化的 bigint**（JSON 不支持 bigint）。
 * 2. 不出现 `number` 表示金额。
 * 3. 不出现 `net` / `balance` 这类汇总抵消字段（赛题要求收支分列）。
 * 4. DTO 不带行为，只有 `readonly` 字段。
 */

import type { Money } from '@harness/domain';

/** 金额的传输形态。`cents` 为十进制字符串，可精确还原为 bigint。 */
export interface MoneyDto {
  /** 分，字符串形式，如 `"962206"`。 */
  readonly cents: string;
  /** 带千分位的展示形式，如 `"9,622.06"`。 */
  readonly formatted: string;
  readonly currency: 'CNY';
}

export function toMoneyDto(money: Money): MoneyDto {
  return {
    cents: money.cents.toString(),
    formatted: money.format(),
    currency: 'CNY',
  };
}

/* ------------------------------ 企业 / 用户 ------------------------------ */

export interface EnterpriseDto {
  readonly id: string;
  readonly fullName: string;
  readonly shortName: string;
}

export interface UserDto {
  readonly id: string;
  readonly displayName: string;
}

/** 权限在 DTO 里是字符串字面量，避免上层依赖 domain 的运行时常量。 */
export type AccessLevelDto = 'read-write' | 'read-only' | 'none';

export interface GrantDto {
  readonly userId: string;
  readonly enterpriseId: string;
  readonly level: AccessLevelDto;
}

/* --------------------------------- 发票 --------------------------------- */

/** 用途合规状态。四种必须区分，不能合并。 */
export type InvoicePurposeStatus =
  | 'filled' // 已填
  | 'missing' // 必须填但没填
  | 'allowed-empty' // 没填但规则允许
  | 'not-evaluated'; // 本次未做合规判定（例如只查金额）

export interface InvoiceView {
  readonly enterpriseId: string;
  readonly invoiceNo: string;
  readonly issuedOn: string;
  readonly sellerName: string;
  readonly itemName: string;
  readonly amount: MoneyDto;
  readonly purpose: string | null;
  readonly remark: string | null;
  readonly purposeStatus: InvoicePurposeStatus;
}

/** 缺项清单里的一项，带「为什么」。 */
export interface InvoiceGapItem {
  readonly invoiceNo: string;
  readonly issuedOn: string;
  readonly sellerName: string;
  readonly itemName: string;
  readonly amount: MoneyDto;
  /** 面向用户的判定说明，如「金额 600.00 元低于 1,000.00 元门槛，可以不填」。 */
  readonly reason: string;
}

/* --------------------------------- 规则 --------------------------------- */

export interface RuleReference {
  readonly code: string;
  readonly version: string;
  readonly title: string;
  readonly scope: string;
  readonly effectiveFrom: string;
  readonly status: string;
  readonly summary?: string;
}

export type RuleRejectionReasonDto =
  | 'disabled'
  | 'other-enterprise'
  | 'not-yet-effective'
  | 'superseded'
  | 'category-not-needed';

export interface RuleRejectionDto {
  readonly code: string;
  readonly version: string;
  readonly reason: RuleRejectionReasonDto;
  /** 面向人的解释，可直接进回复。 */
  readonly detail: string;
}

export interface RuleExplanationDto {
  readonly enterpriseId: string | null;
  readonly month: string | null;
  readonly applied: readonly RuleReference[];
  readonly excluded: readonly RuleRejectionDto[];
  /** 选择算法的自然语言说明，如「同一编号取生效日期最新的版本」。 */
  readonly rationale: string;
}

/* -------------------------------- 用例结果 ------------------------------- */

export type DenialReasonDto =
  | 'no_grant'
  | 'enterprise_not_accessible'
  | 'read_only_enterprise'
  | 'field_not_mutable';

export interface SummarizeMonthOk {
  readonly kind: 'ok';
  readonly enterprise: EnterpriseDto;
  readonly month: string;
  readonly invoice: {
    readonly count: number;
    readonly total: MoneyDto;
  };
  readonly bank: {
    readonly count: number;
    /** 支出合计。与 income 分别统计，永不抵消。 */
    readonly expense: MoneyDto;
    /** 收入合计。 */
    readonly income: MoneyDto;
  };
  readonly applicableRules: readonly RuleReference[];
}

/** 有权限但该期间没有记录。**不等于**无权限。 */
export interface SummarizeMonthEmpty {
  readonly kind: 'empty';
  readonly enterprise: EnterpriseDto;
  readonly month: string;
  readonly note: '该期间没有记录';
  readonly invoice: { readonly count: 0; readonly total: MoneyDto };
  readonly bank: { readonly count: 0; readonly expense: MoneyDto; readonly income: MoneyDto };
}

export interface SummarizeMonthDenied {
  readonly kind: 'denied';
  readonly enterpriseId: string;
  readonly reason: DenialReasonDto;
  readonly message: string;
}

export type SummarizeMonthResult = SummarizeMonthOk | SummarizeMonthEmpty | SummarizeMonthDenied;

export interface FindPurposeGapsOk {
  readonly kind: 'ok';
  readonly enterprise: EnterpriseDto;
  readonly month: string;
  /** 本次判定依据的规则。 */
  readonly rule: RuleReference;
  /** 必须填但空着 —— 真正不合规。 */
  readonly gaps: readonly InvoiceGapItem[];
  /** 空着但规则允许 —— 不是问题，但用户可能想补。 */
  readonly optional: readonly InvoiceGapItem[];
  readonly totalInvoices: number;
}

export interface FindPurposeGapsNoRule {
  readonly kind: 'no-rule';
  readonly enterprise: EnterpriseDto;
  readonly month: string;
  readonly reason: 'no_applicable_purpose_rule';
  readonly message: string;
}

export type FindPurposeGapsResult =
  | FindPurposeGapsOk
  | FindPurposeGapsNoRule
  | SummarizeMonthDenied;

export type GetInvoiceResult =
  | {
      readonly kind: 'ok';
      readonly invoice: InvoiceView;
      readonly purposeRule: RuleReference | null;
    }
  | { readonly kind: 'not-found'; readonly enterpriseId: string; readonly invoiceNo: string }
  | SummarizeMonthDenied;

/* -------------------------------- 记忆 --------------------------------- */

export type TaskCardStateDto = 'active' | 'completed' | 'abandoned';

export interface TaskCardSnapshotDto {
  readonly userId: string;
  readonly enterpriseId: string;
  readonly month: string;
  readonly state: TaskCardStateDto;
  readonly pending: readonly InvoiceGapItem[];
  readonly completed: readonly InvoiceGapItem[];
  readonly note: string | null;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface MemoryRecordSnapshotDto {
  readonly userId: string;
  readonly enterpriseId: string;
  readonly key: string;
  readonly value: string;
  readonly updatedAt: string;
}

export interface ViewMemoryResult {
  readonly taskCard: TaskCardSnapshotDto | null;
  readonly preferences: readonly MemoryRecordSnapshotDto[];
}

/* -------------------------------- 运行记录 ------------------------------- */

export type StepStatusDto = 'started' | 'succeeded' | 'failed' | 'skipped';

export interface ToolCallRecordDto {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  readonly ok: boolean;
  readonly result: unknown;
  readonly elapsedMs: number;
  readonly errorCode?: string;
}

export interface ProvenanceRecordDto {
  /** 回复中出现的字面量，如 `"9,622.06"`。 */
  readonly literal: string;
  /** 来源，如 `"tool:summarize_enterprise_month#invoice.total"`。 */
  readonly source: string;
  readonly ok: boolean;
}

export interface TraceStepRecordDto {
  readonly index: number;
  readonly status: StepStatusDto;
  readonly toolCalls: readonly ToolCallRecordDto[];
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly elapsedMs: number;
}

export interface TraceContextDto {
  readonly instructions: string;
  readonly instructionsHash: string;
  readonly userId: string | null;
  readonly enterpriseId: string | null;
  readonly accessLevel: AccessLevelDto | null;
  readonly memory: {
    readonly taskCardId: string | null;
    readonly preferenceKeys: readonly string[];
  };
  readonly rules: readonly RuleReference[];
  readonly historyMessages: number;
  readonly estimatedTokens: number;
  readonly degradeLevel: 'L0' | 'L1' | 'L2';
}

export interface TraceRunRecord {
  readonly runId: string;
  readonly sessionId: string | null;
  readonly userId: string | null;
  readonly enterpriseId: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly elapsedMs: number;
  readonly model: { readonly providerId: string; readonly modelId: string };
  readonly context: TraceContextDto;
  readonly steps: readonly TraceStepRecordDto[];
  readonly provenance: readonly ProvenanceRecordDto[];
  readonly finalText: string;
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface TraceSummary {
  readonly runId: string;
  readonly startedAt: string;
  readonly userId: string | null;
  readonly enterpriseId: string | null;
  readonly stepCount: number;
  readonly elapsedMs: number;
  readonly finalTextPreview: string;
  readonly hasError: boolean;
}
