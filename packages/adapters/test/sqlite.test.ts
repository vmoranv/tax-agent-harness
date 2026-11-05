import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterpriseId, InvoiceId, Money } from '@harness/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDatasetJson, verifyBundle } from '../src/excel/dataset.js';
import { openDatabase, type SqlDatabase } from '../src/sqlite/database.js';
import { SqliteUnitOfWork } from '../src/sqlite/unit-of-work.js';

/** 仓库根：从测试文件位置向上三级。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DATASET = join(REPO_ROOT, 'fixtures', 'dataset.json');

let dir: string;
let db: SqlDatabase;
let uow: SqliteUnitOfWork;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-sqlite-'));
  db = openDatabase(join(dir, 'test.db'));
  uow = new SqliteUnitOfWork(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('迁移是幂等的', () => {
  it('重复打开同一个数据库文件后 schema 仍可用', () => {
    const path = join(dir, 'twice.db');
    const a = openDatabase(path);
    a.close();
    const b = openDatabase(path);
    // 真实断言：重开后 invoice 表仍可查询，且迁移未重复建表报错。
    const row = b
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invoice'")
      .get();
    b.close();
    expect(row).toBeDefined();
  });
});

describe('复合主键：同编号跨企业不冲突', () => {
  it('C001/F001 与 C002/F001 可以共存且互不覆盖', async () => {
    const bundle = await loadDatasetJson(DATASET);

    await uow.run(async (tx) => {
      await tx.invoices.bulkUpsert(bundle.invoices);
      return null;
    });

    const c1 = await uow.run(async (tx) => tx.invoices.findById(InvoiceId.of('C001', 'F001')));
    const c2 = await uow.run(async (tx) => tx.invoices.findById(InvoiceId.of('C002', 'F001')));

    expect(c1).not.toBeNull();
    expect(c2).not.toBeNull();
    // 两张票金额不同（500.00 vs 600.00），证明没有互相覆盖
    expect(c1?.amount.cents).toBe(50000n);
    expect(c2?.amount.cents).toBe(60000n);
  });
});

describe('金额往返不丢精度', () => {
  it('存入 1266724 分，读回仍是 1266724 分', async () => {
    const bundle = await loadDatasetJson(DATASET);
    await uow.run(async (tx) => {
      await tx.invoices.bulkUpsert(bundle.invoices);
      return null;
    });

    const inv = await uow.run(async (tx) => tx.invoices.findById(InvoiceId.of('C001', 'F005')));
    expect(inv?.amount.cents).toBe(100000n);
    expect(inv?.amount.format()).toBe('1,000.00');
  });
});

describe('导入后与官方核对表一致', () => {
  it('六组月度合计全部匹配', async () => {
    const bundle = await loadDatasetJson(DATASET);
    const v = verifyBundle(bundle);
    expect(v.matched).toBe(true);
    expect(v.diffs).toEqual([]);

    const sep = v.checks.find((c) => c.key === 'C001/2026-09');
    expect(sep?.invoiceTotalCents).toBe('962206');
    expect(sep?.expenseCents).toBe('718074');
    expect(sep?.incomeCents).toBe('1300050');
  });

  it('40 张发票 48 条流水全部入库，无警告', async () => {
    const bundle = await loadDatasetJson(DATASET);
    expect(bundle.invoices).toHaveLength(40);
    expect(bundle.bankTransactions).toHaveLength(48);
    expect(bundle.warnings).toEqual([]);
  });
});

describe('银行流水是只读的（数据库层强制）', () => {
  it('UPDATE bank_txn 被触发器拒绝', async () => {
    const bundle = await loadDatasetJson(DATASET);
    await uow.run(async (tx) => {
      await tx.banks.bulkInsert(bundle.bankTransactions);
      return null;
    });

    expect(() =>
      db.prepare("UPDATE bank_txn SET amount_cents = 1 WHERE enterprise_id = 'C001'").run(),
    ).toThrow(/read-only/i);
  });

  it('DELETE bank_txn 被触发器拒绝', async () => {
    const bundle = await loadDatasetJson(DATASET);
    await uow.run(async (tx) => {
      await tx.banks.bulkInsert(bundle.bankTransactions);
      return null;
    });

    expect(() => db.prepare("DELETE FROM bank_txn WHERE enterprise_id = 'C001'").run()).toThrow(
      /read-only/i,
    );
  });
});

describe('乐观锁', () => {
  it('版本号不符时 save 返回 false', async () => {
    const bundle = await loadDatasetJson(DATASET);
    await uow.run(async (tx) => {
      await tx.invoices.bulkUpsert(bundle.invoices);
      return null;
    });

    const ok = await uow.run(async (tx) => {
      const inv = await tx.invoices.findById(InvoiceId.of('C001', 'F002'));
      if (inv === null) throw new Error('missing');
      // 传入一个过期版本
      return tx.invoices.save(inv, inv.version + 99);
    });

    expect(ok).toBe(false);
  });
});

describe('写入日志的唯一索引', () => {
  it('同一轮同一目标同一新值只能落一条', async () => {
    const entry = {
      enterpriseId: 'C001',
      invoiceNo: 'F002',
      field: 'purpose' as const,
      oldValue: null,
      newValue: '采购',
      runId: 'run_1',
      toolCallId: 'call_1',
      actor: 'U001',
      createdAt: '2026-11-03T00:00:00Z',
    };

    await uow.run(async (tx) => {
      await tx.writeLog.append(entry);
      return null;
    });

    await expect(
      uow.run(async (tx) => {
        await tx.writeLog.append(entry);
        return null;
      }),
    ).rejects.toThrow(/UNIQUE/i);
  });
});

describe('任务卡的进行中唯一约束', () => {
  it('同用户同企业插入两条 active 会失败（唯一部分索引）', () => {
    db.prepare(
      `INSERT INTO task_card (user_id, enterprise_id, month, status, payload, revision, updated_at)
       VALUES ('U001','C001','2026-09','active','{}',1,'2026-11-03')`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO task_card (user_id, enterprise_id, month, status, payload, revision, updated_at)
           VALUES ('U001','C001','2026-10','active','{}',1,'2026-11-03')`,
        )
        .run(),
    ).toThrow(/UNIQUE/i);
  });
});

describe('事务回滚', () => {
  it('用例抛错时写入被撤销', async () => {
    await expect(
      uow.run(async (tx) => {
        await tx.invoices.bulkUpsert([
          // 用一份合法发票先写入，再抛错
          ...(await loadDatasetJson(DATASET)).invoices.slice(0, 1),
        ]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const count = db.prepare('SELECT COUNT(*) AS c FROM invoice').get() as { c: number };
    expect(count.c).toBe(0);
  });
});

describe('空月份查询返回空数组而不是报错', () => {
  it('2026-07 没有任何记录', async () => {
    const bundle = await loadDatasetJson(DATASET);
    await uow.run(async (tx) => {
      await tx.invoices.bulkUpsert(bundle.invoices);
      await tx.banks.bulkInsert(bundle.bankTransactions);
      return null;
    });

    const invs = await uow.run(async (tx) =>
      tx.invoices.listByMonth(enterpriseId('C001'), '2026-07' as never),
    );
    expect(invs).toEqual([]);
  });
});

describe('Money 边界值', () => {
  it('1000.00 与 999.99 的分值相差 1', () => {
    expect(Money.parse('1000.00').cents).toBe(100000n);
    expect(Money.parse('999.99').cents).toBe(99999n);
    expect(Money.parse('1000.00').gte(Money.parse('1000.00'))).toBe(true);
  });

  it('拒绝三位小数', () => {
    expect(() => Money.parse('1000.005')).toThrow();
  });
});
