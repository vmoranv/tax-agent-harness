import { describe, expect, it } from 'vitest';
import {
  InvalidIdentifierError,
  isInMonth,
  monthEndExclusive,
  monthStart,
  parseIsoDate,
  parseMonth,
} from '../src/index.js';

describe('Month', () => {
  it('接受 2026-09 这类格式', () => {
    expect(parseMonth('2026-09')).toBe('2026-09');
    expect(parseMonth('2026-01')).toBe('2026-01');
    expect(parseMonth('2026-12')).toBe('2026-12');
  });

  it('拒绝 13 月与单位数月份', () => {
    expect(() => parseMonth('2026-13')).toThrow(InvalidIdentifierError);
    expect(() => parseMonth('2026-00')).toThrow(InvalidIdentifierError);
    expect(() => parseMonth('2026-9')).toThrow(InvalidIdentifierError);
    expect(() => parseMonth('2026/09')).toThrow(InvalidIdentifierError);
    expect(() => parseMonth('')).toThrow(InvalidIdentifierError);
  });

  it('monthStart 为当月 1 日', () => {
    expect(monthStart(parseMonth('2026-09'))).toBe('2026-09-01');
  });

  it('monthEndExclusive 为下月 1 日（半开区间）', () => {
    expect(monthEndExclusive(parseMonth('2026-09'))).toBe('2026-10-01');
    expect(monthEndExclusive(parseMonth('2026-08'))).toBe('2026-09-01');
  });

  it('12 月的下月跨年', () => {
    expect(monthEndExclusive(parseMonth('2026-12'))).toBe('2027-01-01');
  });

  it('isInMonth 半开区间：含 1 日、不含下月 1 日', () => {
    const m = parseMonth('2026-09');
    expect(isInMonth(parseIsoDate('2026-09-01'), m)).toBe(true);
    expect(isInMonth(parseIsoDate('2026-09-30'), m)).toBe(true);
    expect(isInMonth(parseIsoDate('2026-10-01'), m)).toBe(false);
    expect(isInMonth(parseIsoDate('2026-08-31'), m)).toBe(false);
  });
});

describe('IsoDate', () => {
  it('接受合法日期', () => {
    expect(parseIsoDate('2026-09-01')).toBe('2026-09-01');
    expect(parseIsoDate('2026-02-28')).toBe('2026-02-28');
  });

  it('闰年校验', () => {
    expect(parseIsoDate('2024-02-29')).toBe('2024-02-29');
    expect(() => parseIsoDate('2026-02-29')).toThrow(InvalidIdentifierError);
    expect(() => parseIsoDate('2100-02-29')).toThrow(InvalidIdentifierError);
    expect(parseIsoDate('2000-02-29')).toBe('2000-02-29');
  });

  it('拒绝越界日与越界月', () => {
    expect(() => parseIsoDate('2026-04-31')).toThrow(InvalidIdentifierError);
    expect(() => parseIsoDate('2026-13-01')).toThrow(InvalidIdentifierError);
    expect(() => parseIsoDate('2026-09-00')).toThrow(InvalidIdentifierError);
    expect(() => parseIsoDate('2026-9-1')).toThrow(InvalidIdentifierError);
    expect(() => parseIsoDate('2026-09-01T00:00:00Z')).toThrow(InvalidIdentifierError);
  });
});
