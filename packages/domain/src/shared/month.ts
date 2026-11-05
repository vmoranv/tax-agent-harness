import type { Brand } from './brand.js';
import { InvalidIdentifierError } from './domain-error.js';

/** 会计月份，形如 2026-09。 */
export type Month = Brand<string, 'Month'>;
/** 日历日期，形如 2026-09-01。 */
export type IsoDate = Brand<string, 'IsoDate'>;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function parseMonth(raw: string): Month {
  if (typeof raw !== 'string' || !MONTH_RE.test(raw)) {
    throw new InvalidIdentifierError('Month', raw, '应形如 2026-09');
  }
  return raw as Month;
}

export function parseIsoDate(raw: string): IsoDate {
  const m = typeof raw === 'string' ? DATE_RE.exec(raw) : null;
  if (!m) {
    throw new InvalidIdentifierError('IsoDate', raw, '应形如 2026-09-01');
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw new InvalidIdentifierError('IsoDate', raw, '不是合法的日历日期');
  }
  return raw as IsoDate;
}

/** 当月第一天（含）。 */
export function monthStart(month: Month): IsoDate {
  return `${month}-01` as IsoDate;
}

/** 下月第一天（不含）：半开区间 [monthStart, monthEndExclusive)。 */
export function monthEndExclusive(month: Month): IsoDate {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const nextYear = m === 12 ? year + 1 : year;
  const nextMonth = m === 12 ? 1 : m + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01` as IsoDate;
}

/** 半开区间判定：date >= 月初 且 date < 下月初。 */
export function isInMonth(date: IsoDate, month: Month): boolean {
  return date >= monthStart(month) && date < monthEndExclusive(month);
}
