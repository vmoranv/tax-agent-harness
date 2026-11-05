/**
 * 错误码与错误类。
 *
 * 设计原则：**失败是结构化数据，不是异常字符串**。
 * 工具层 `execute` 不 throw，而是返回 `{ ok: false, error }`，
 * 让模型能读懂「发生了什么、下一步该怎么做」。
 */

/**
 * 工具错误码。
 *
 * 每一条都对应一种**用户可见的处置方式**，不可合并：
 * - `ACCESS_DENIED` 与 `EMPTY` 必须分开，否则会把「无权限」说成「没有记录」。
 * - `MISSING_PARAMETER` 是唯一会让模型**追问**的码。
 */
export type ToolErrorCode =
  | 'MISSING_PARAMETER'
  | 'ENTITY_NOT_FOUND'
  | 'ACCESS_DENIED'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'VERIFY_MISMATCH'
  | 'TASK_IN_PROGRESS'
  | 'UNSUPPORTED_RULE'
  | 'INTERNAL';

/** 面向模型的错误载荷。`hint` 指导下一步动作。 */
export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly details?: unknown;
}

/** 工具返回值：成功或失败，二选一。 */
export type ToolOutcome<T> =
  | { readonly ok: true; readonly data: T; readonly meta?: ToolMeta }
  | { readonly ok: false; readonly error: ToolError };

export interface ToolMeta {
  readonly elapsedMs: number;
  /** 本次结果依据的规则，供回复引用。 */
  readonly ruleRefs?: ReadonlyArray<{ readonly code: string; readonly version: string }>;
}

/* ------------------------------ 错误类 ------------------------------ */

/** 所有应用层错误基类。`code` 可直接映射为 HTTP 状态与 CLI 退出码。 */
export abstract class AppError extends Error {
  abstract readonly code: ToolErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }

  toToolError(hint?: string): ToolError {
    return hint === undefined
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message, hint, details: this.details };
  }
}

export class MissingParameterError extends AppError {
  readonly code = 'MISSING_PARAMETER' as const;
}

export class EntityNotFoundError extends AppError {
  readonly code = 'ENTITY_NOT_FOUND' as const;
}

export class AccessDeniedError extends AppError {
  readonly code = 'ACCESS_DENIED' as const;
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_FAILED' as const;
}

export class ConflictError extends AppError {
  readonly code = 'CONFLICT' as const;
}

export class VerifyMismatchError extends AppError {
  readonly code = 'VERIFY_MISMATCH' as const;
}

export class TaskInProgressError extends AppError {
  readonly code = 'TASK_IN_PROGRESS' as const;
}

export class UnsupportedRuleError extends AppError {
  readonly code = 'UNSUPPORTED_RULE' as const;
}

/* --------------------------- HTTP / CLI 映射 --------------------------- */

/** HTTP 状态码映射（server 层用）。 */
export const HTTP_STATUS: Readonly<Record<ToolErrorCode, number>> = {
  MISSING_PARAMETER: 400,
  ENTITY_NOT_FOUND: 404,
  ACCESS_DENIED: 403,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  VERIFY_MISMATCH: 500,
  TASK_IN_PROGRESS: 409,
  UNSUPPORTED_RULE: 501,
  INTERNAL: 500,
};

/** CLI 退出码映射。 */
export const CLI_EXIT_CODE: Readonly<Record<ToolErrorCode, number>> = {
  MISSING_PARAMETER: 2,
  ENTITY_NOT_FOUND: 3,
  ACCESS_DENIED: 4,
  VALIDATION_FAILED: 5,
  CONFLICT: 6,
  VERIFY_MISMATCH: 7,
  TASK_IN_PROGRESS: 8,
  UNSUPPORTED_RULE: 9,
  INTERNAL: 1,
};
