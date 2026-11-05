/**
 * 赛题数据的核对基准。
 * 由 Python 用 Decimal 对 `fixtures/excel/02_示例数据.xlsx` 重算得出，
 * 与 Excel「说明」页的汇总完全一致。
 *
 * 所有金额单位为「分」（bigint），跨层零浮点。
 */

export interface MonthTotals {
  readonly invoiceTotalCents: bigint;
  readonly bankExpenseCents: bigint;
  readonly bankIncomeCents: bigint;
  readonly invoiceCount: number;
  readonly bankCount: number;
}

export const GOLDEN_MONTHS: Readonly<Record<string, MonthTotals>> = {
  'C001/2026-07': {
    invoiceTotalCents: 0n,
    bankExpenseCents: 0n,
    bankIncomeCents: 0n,
    invoiceCount: 0,
    bankCount: 0,
  },
  'C001/2026-08': {
    invoiceTotalCents: 904635n,
    bankExpenseCents: 572099n,
    bankIncomeCents: 1485075n,
    invoiceCount: 10,
    bankCount: 12,
  },
  'C001/2026-09': {
    invoiceTotalCents: 962206n,
    bankExpenseCents: 718074n,
    bankIncomeCents: 1300050n,
    invoiceCount: 10,
    bankCount: 12,
  },
  'C002/2026-07': {
    invoiceTotalCents: 0n,
    bankExpenseCents: 0n,
    bankIncomeCents: 0n,
    invoiceCount: 0,
    bankCount: 0,
  },
  'C002/2026-08': {
    invoiceTotalCents: 1366705n,
    bankExpenseCents: 934110n,
    bankIncomeCents: 1880025n,
    invoiceCount: 10,
    bankCount: 12,
  },
  'C002/2026-09': {
    invoiceTotalCents: 1266724n,
    bankExpenseCents: 808724n,
    bankIncomeCents: 1370075n,
    invoiceCount: 10,
    bankCount: 12,
  },
};

/** 2026-09 的用途缺口（按各企业适用规则判定） */
export const GOLDEN_PURPOSE_GAPS: Readonly<
  Record<string, { required: readonly string[]; optional: readonly string[] }>
> = {
  'C001/2026-09': {
    required: ['F002', 'F003', 'F004', 'F006', 'F009'],
    optional: [],
  },
  'C002/2026-09': {
    required: ['F002', 'F005', 'F006'],
    optional: ['F001', 'F004', 'F009'],
  },
};

/** 适用的规则（code@version），按 (企业, 月份) */
export const GOLDEN_RULES: Readonly<Record<string, readonly string[]>> = {
  'C001/2026-09': ['R001@1.0', 'R002@2.0', 'R004@1.0'],
  'C002/2026-09': ['R001@1.0', 'R003@1.0', 'R004@1.0'],
};

/** 边界发票：金额恰为门槛或差一分 */
export const GOLDEN_EDGE_INVOICES = {
  /** 1000.00 — 等于门槛，必须判为 required */
  exactlyAtThreshold: { enterpriseId: 'C002', invoiceNo: 'F002', amountCents: 100000n },
  /** 999.99 — 差一分，允许为空 */
  justBelowThreshold: { enterpriseId: 'C002', invoiceNo: 'F004', amountCents: 99999n },
  /** 1000.01 — 刚过门槛 */
  justAboveThreshold: { enterpriseId: 'C002', invoiceNo: 'F005', amountCents: 100001n },
} as const;

/** 演示时的企业/用户 */
export const GOLDEN_ACTORS = {
  u001: { userId: 'U001', c001: 'read-write', c002: 'read-write' },
  u002: { userId: 'U002', c001: 'read-only', c002: 'none' },
} as const;
