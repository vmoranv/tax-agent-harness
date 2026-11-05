import { describe, expect, it } from 'vitest';
import { formatCents, InvalidMoneyError, Money, parseCents } from '../src/index.js';

describe('Money', () => {
  it('把元字符串解析为 bigint 分', () => {
    expect(Money.parse('1000.00').cents).toBe(100000n);
    expect(Money.parse('9622.06').cents).toBe(962206n);
    expect(Money.parse('0.01').cents).toBe(1n);
  });

  it('接受整数金额（无小数点）', () => {
    expect(Money.parse('1000').cents).toBe(100000n);
    expect(Money.parse('1').cents).toBe(100n);
  });

  it('接受单小数位并补零', () => {
    expect(Money.parse('460.5').cents).toBe(46050n);
  });

  it('拒绝三位小数', () => {
    expect(() => Money.parse('1000.005')).toThrow(InvalidMoneyError);
    expect(() => Money.parse(1000.005)).toThrow(InvalidMoneyError);
  });

  it('拒绝负数', () => {
    expect(() => Money.parse('-1.00')).toThrow(InvalidMoneyError);
    expect(() => Money.fromCents(-1n)).toThrow(InvalidMoneyError);
  });

  it('拒绝千分位、货币符号与指数形式', () => {
    expect(() => Money.parse('1,000.00')).toThrow(InvalidMoneyError);
    expect(() => Money.parse('¥1000.00')).toThrow(InvalidMoneyError);
    expect(() => Money.parse('1e3')).toThrow(InvalidMoneyError);
    expect(() => Money.parse(1e21)).toThrow(InvalidMoneyError);
  });

  it('fromCents 拒绝非安全整数', () => {
    expect(() => Money.fromCents(1.5)).toThrow(InvalidMoneyError);
    expect(() => Money.fromCents(Number.MAX_SAFE_INTEGER + 2)).toThrow(InvalidMoneyError);
    expect(Money.fromCents(100000).cents).toBe(100000n);
  });

  it('format 默认千分位分组', () => {
    expect(Money.parse('9622.06').format()).toBe('9,622.06');
    expect(Money.parse('13000.50').format()).toBe('13,000.50');
    expect(Money.parse('999.99').format()).toBe('999.99');
    expect(Money.zero().format()).toBe('0.00');
  });

  it('format 可关闭分组', () => {
    expect(Money.parse('9622.06').format({ grouped: false })).toBe('9622.06');
  });

  it('1000.00 gte 1000 为真（门槛含等号）', () => {
    expect(Money.parse('1000.00').gte(Money.parse('1000'))).toBe(true);
    expect(Money.parse('999.99').gte(Money.parse('1000'))).toBe(false);
  });

  it('add / subtract / compare / equals / isZero', () => {
    const a = Money.parse('500.00');
    const b = Money.parse('300.50');
    expect(a.add(b).format()).toBe('800.50');
    expect(a.subtract(b).format()).toBe('199.50');
    expect(a.compare(b)).toBe(1);
    expect(b.compare(a)).toBe(-1);
    expect(a.compare(Money.parse('500'))).toBe(0);
    expect(a.equals(Money.parse('500.00'))).toBe(true);
    expect(Money.zero().isZero()).toBe(true);
    expect(a.isZero()).toBe(false);
  });

  it('相减为负时拒绝，不产生负金额', () => {
    expect(() => Money.parse('1.00').subtract(Money.parse('2.00'))).toThrow(InvalidMoneyError);
  });

  it('toJSON 输出分与格式化金额', () => {
    expect(Money.parse('9622.06').toJSON()).toEqual({
      cents: '962206',
      formatted: '9,622.06',
    });
  });

  it('parseCents / formatCents 便捷函数', () => {
    expect(parseCents('7180.74')).toBe(718074n);
    expect(formatCents(718074n)).toBe('7,180.74');
    expect(formatCents(718074n, { grouped: false })).toBe('7180.74');
  });
});
