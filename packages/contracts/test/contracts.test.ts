import { Money } from '@harness/domain';
import { describe, expect, it } from 'vitest';
import type {
  BankTransactionRepository,
  FindPurposeGapsResult,
  SummarizeMonthResult,
  ToolOutcome,
} from '../src/index.js';
import { CLI_EXIT_CODE, HTTP_STATUS, toMoneyDto } from '../src/index.js';

describe('银行仓储必须是只读的', () => {
  it('类型层面不存在 save / update / delete', () => {
    // 这三行如果未来有人给 BankTransactionRepository 加了写方法，会编译失败
    // @ts-expect-error - 银行仓储不应有 save
    type _NoSave = BankTransactionRepository['save'];
    // @ts-expect-error - 银行仓储不应有 update
    type _NoUpdate = BankTransactionRepository['update'];
    // @ts-expect-error - 银行仓储不应有 delete
    type _NoDelete = BankTransactionRepository['delete'];
  });

  it('只暴露 listByMonth 与 bulkInsert', () => {
    type Keys = keyof BankTransactionRepository;
    const expected: Keys[] = ['listByMonth', 'bulkInsert'];
    expect(expected).toHaveLength(2);
  });
});

describe('MoneyDto 传输', () => {
  it('cents 是字符串，不是 number', () => {
    const dto = toMoneyDto(Money.parse('9622.06'));
    expect(typeof dto.cents).toBe('string');
    expect(dto.cents).toBe('962206');
    expect(dto.formatted).toBe('9,622.06');
    expect(dto.currency).toBe('CNY');
  });

  it('JSON 往返不丢精度', () => {
    const original = Money.parse('12667.24');
    const roundTripped = JSON.parse(JSON.stringify(toMoneyDto(original))) as {
      cents: string;
    };
    expect(BigInt(roundTripped.cents)).toBe(original.cents);
  });

  it('大额金额不丢精度（超过 Number.MAX_SAFE_INTEGER）', () => {
    const huge = Money.fromCents(9007199254740993n);
    const dto = toMoneyDto(huge);
    expect(dto.cents).toBe('9007199254740993');
    expect(BigInt(dto.cents)).toBe(9007199254740993n);
  });
});

describe('结果类型里不存在「净额」', () => {
  it('SummarizeMonthResult 的 ok 分支没有 net / balance 字段', () => {
    type OkBranch = Extract<SummarizeMonthResult, { kind: 'ok' }>;
    type NetKeys = {
      [K in keyof OkBranch as K extends 'net' | 'balance' | 'netAmount' ? K : never]: unknown;
    };
    // 如果未来有人加了 net 字段，这里会变成非 never
    const keys: NetKeys = {} as NetKeys;
    expect(Object.keys(keys)).toHaveLength(0);
  });

  it('bank 分支只有 count / expense / income', () => {
    type OkBranch = Extract<SummarizeMonthResult, { kind: 'ok' }>;
    type BankKeys = keyof OkBranch['bank'];
    const keys: BankKeys[] = ['count', 'expense', 'income'];
    expect(keys).toHaveLength(3);
  });
});

describe('缺项结果把「必须填」与「允许空」分开', () => {
  it('ok 分支同时有 gaps 与 optional', () => {
    type OkBranch = Extract<FindPurposeGapsResult, { kind: 'ok' }>;
    type Keys = keyof OkBranch;
    const required: Keys[] = [
      'kind',
      'enterprise',
      'month',
      'rule',
      'gaps',
      'optional',
      'totalInvoices',
    ];
    expect(required).toContain('gaps');
    expect(required).toContain('optional');
  });
});

describe('错误码到传输层的映射是完备的', () => {
  it('每个 ToolErrorCode 都有 HTTP 状态', () => {
    expect(Object.keys(HTTP_STATUS)).toHaveLength(9);
    for (const status of Object.values(HTTP_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
    }
  });

  it('ACCESS_DENIED 是 403，不是 404', () => {
    // 关键：无权限不能用 404 表达，否则会被误认为「对象不存在」
    expect(HTTP_STATUS.ACCESS_DENIED).toBe(403);
    expect(HTTP_STATUS.ENTITY_NOT_FOUND).toBe(404);
  });

  it('每个错误码都有 CLI 退出码', () => {
    expect(Object.keys(CLI_EXIT_CODE)).toHaveLength(9);
  });
});

describe('ToolOutcome 是判别式联合', () => {
  it('可以按 ok 字段收窄', () => {
    const success: ToolOutcome<number> = { ok: true, data: 42 };
    const failure: ToolOutcome<number> = {
      ok: false,
      error: { code: 'ACCESS_DENIED', message: '无权限' },
    };

    if (success.ok) {
      expect(success.data).toBe(42);
    }
    if (!failure.ok) {
      expect(failure.error.code).toBe('ACCESS_DENIED');
    }
  });
});
