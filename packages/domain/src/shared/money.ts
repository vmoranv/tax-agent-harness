import { InvalidMoneyError } from './domain-error.js';

/** 至多两位小数的十进制字符串；不接受指数、千分位、货币符号。 */
const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/**
 * 把 number 输入转成十进制字符串。
 *
 * 不能用 `toFixed(2)`：它会把 1000.005 静默四舍五入成 1000.01，
 * 而这正是导入环节必须报错的情况。
 */
function toDecimalString(input: string | number): string {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new InvalidMoneyError(`无法解析金额: ${String(input)}`);
    }
    const s = String(input);
    if (s.includes('e') || s.includes('E')) {
      throw new InvalidMoneyError(`无法解析金额: ${String(input)}`);
    }
    return s;
  }
  return input.trim();
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 金额值对象：内部一律以 bigint「分」存储，跨层零浮点。
 *
 * 不变量：`cents >= 0`。负数在构造时即被拒绝，
 * 因此任何 Money 实例都是合法金额。
 */
export class Money {
  private constructor(readonly cents: bigint) {
    if (cents < 0n) {
      throw new InvalidMoneyError('金额不能为负', { cents: cents.toString() });
    }
  }

  static zero(): Money {
    return new Money(0n);
  }

  static fromCents(cents: bigint | number): Money {
    if (typeof cents === 'number') {
      if (!Number.isSafeInteger(cents)) {
        throw new InvalidMoneyError(`金额（分）必须是安全整数: ${String(cents)}`);
      }
      return new Money(BigInt(cents));
    }
    return new Money(cents);
  }

  /** 从 '9622.06' / 9622.06 构造；拒绝负数与超过两位小数。 */
  static parse(input: string | number): Money {
    const s = toDecimalString(input);
    const m = DECIMAL_RE.exec(s);
    if (!m) {
      throw new InvalidMoneyError(`无法解析金额: ${String(input)}`);
    }
    const sign = m[1];
    const intPart = m[2] ?? '0';
    const fracPart = m[3] ?? '';
    const cents = BigInt(intPart) * 100n + BigInt(fracPart.padEnd(2, '0'));
    if (sign === '-') {
      throw new InvalidMoneyError('金额不能为负', { raw: s });
    }
    return new Money(cents);
  }

  add(other: Money): Money {
    return new Money(this.cents + other.cents);
  }

  subtract(other: Money): Money {
    return new Money(this.cents - other.cents);
  }

  compare(other: Money): -1 | 0 | 1 {
    if (this.cents < other.cents) return -1;
    if (this.cents > other.cents) return 1;
    return 0;
  }

  gte(other: Money): boolean {
    return this.cents >= other.cents;
  }

  equals(other: Money): boolean {
    return this.cents === other.cents;
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  /** 默认按千分位分组：'9,622.06'；`grouped: false` 时输出 '9622.06'。 */
  format(options: { grouped?: boolean } = {}): string {
    const negative = this.cents < 0n;
    const abs = negative ? -this.cents : this.cents;
    const yuan = abs / 100n;
    const fen = abs % 100n;
    const yuanStr = options.grouped === false ? yuan.toString() : groupThousands(yuan.toString());
    return `${negative ? '-' : ''}${yuanStr}.${fen.toString().padStart(2, '0')}`;
  }

  toJSON(): { cents: string; formatted: string } {
    return { cents: this.cents.toString(), formatted: this.format() };
  }

  toString(): string {
    return this.format();
  }
}

/** 便捷函数：直接得到最小货币单位「分」。 */
export function parseCents(input: string | number): bigint {
  return Money.parse(input).cents;
}

/** 便捷函数：把「分」格式化为两位小数金额。 */
export function formatCents(cents: bigint, options: { grouped?: boolean } = {}): string {
  return Money.fromCents(cents).format(options);
}
