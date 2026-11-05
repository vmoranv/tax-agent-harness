/**
 * 银行流水仓储（PostgreSQL）。
 *
 * **只读**：没有 update / delete 方法。数据库层另有 `BEFORE UPDATE/DELETE`
 * 触发器（见 `migrations/0001_constraints.sql`）作为第二道保险。
 */

import type { BankTransactionRepository } from '@harness/contracts';
import {
  BankTransaction,
  type BankTransactionSnapshot,
  bankTransactionId,
  type EnterpriseId,
  type FlowDirection,
  Money,
  type Month,
  parseIsoDate,
} from '@harness/domain';
import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase } from '../../pg-client.js';
import { bankTxn } from '../../schema/pg.schema.js';

export class PgBankRepository implements BankTransactionRepository {
  constructor(private readonly db: PgDatabase) {}

  async listByMonth(e: EnterpriseId, m: Month): Promise<BankTransaction[]> {
    const rows = await this.db
      .select()
      .from(bankTxn)
      .where(
        and(
          eq(bankTxn.enterpriseId, e),
          sql`date_trunc('month', ${bankTxn.tradedOn}) = ${`${m}-01`}::date`,
        ),
      )
      .orderBy(bankTxn.txnNo);
    return rows.map(toDomain);
  }

  async bulkInsert(rows: readonly BankTransaction[]): Promise<number> {
    if (rows.length === 0) return 0;
    const values = rows.map((t) => {
      const s = t.toSnapshot();
      const idx = s.id.indexOf('/');
      return {
        enterpriseId: s.id.slice(0, idx),
        txnNo: s.id.slice(idx + 1),
        tradedOn: s.occurredOn as string,
        direction: s.direction,
        amountCents: s.amount.cents,
        counterparty: s.counterpartyName,
        remark: s.remark,
      };
    });

    await this.db.insert(bankTxn).values(values).onConflictDoNothing();
    return rows.length;
  }
}

function toDomain(r: typeof bankTxn.$inferSelect): BankTransaction {
  const traded = typeof r.tradedOn === 'string' ? r.tradedOn.slice(0, 10) : toIsoDay(r.tradedOn);
  const snap: BankTransactionSnapshot = {
    id: bankTransactionId(r.enterpriseId, r.txnNo),
    occurredOn: parseIsoDate(traded),
    direction: r.direction as FlowDirection,
    amount: Money.fromCents(BigInt(r.amountCents)),
    counterpartyName: r.counterparty,
    remark: r.remark,
  };
  return BankTransaction.rehydrate(snap);
}

function toIsoDay(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
