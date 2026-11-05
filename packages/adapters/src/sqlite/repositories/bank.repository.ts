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
import {
  fromBigIntCents,
  type SqlDatabase,
  toBigIntCents,
  toStr,
  toStrOrNull,
} from '../database.js';

const COLS = `enterprise_id, txn_no, traded_on, direction, amount_cents, counterparty, remark`;

/**
 * 银行流水仓储。
 *
 * **没有 update / delete 方法** —— 类型层堵死写入路径；
 * 数据库层另有 `BEFORE UPDATE/DELETE` 触发器作为第二道保险。
 */
export class SqlBankRepository implements BankTransactionRepository {
  constructor(private readonly db: SqlDatabase) {}

  async listByMonth(e: EnterpriseId, m: Month): Promise<BankTransaction[]> {
    const rows = this.db
      .prepare(
        `SELECT ${COLS} FROM bank_txn
          WHERE enterprise_id = ? AND traded_month = ?
          ORDER BY txn_no`,
      )
      .all(e, m);
    return rows.map(toTransaction);
  }

  async bulkInsert(transactions: readonly BankTransaction[]): Promise<number> {
    const stmt = this.db.prepare(
      `INSERT INTO bank_txn (${COLS}, traded_month)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT (enterprise_id, txn_no) DO NOTHING`,
    );
    let n = 0;
    for (const t of transactions) {
      const s = t.toSnapshot();
      const [ent, no] = splitId(s.id);
      stmt.run(
        ent,
        no,
        s.occurredOn,
        s.direction,
        fromBigIntCents(s.amount.cents),
        s.counterpartyName,
        s.remark,
        s.occurredOn.slice(0, 7),
      );
      n += 1;
    }
    return n;
  }
}

function splitId(id: string): [string, string] {
  const idx = id.indexOf('/');
  return [id.slice(0, idx), id.slice(idx + 1)];
}

function toTransaction(row: Record<string, unknown>): BankTransaction {
  const ent = toStr(row.enterprise_id);
  const no = toStr(row.txn_no);
  const snap: BankTransactionSnapshot = {
    id: bankTransactionId(ent, no),
    occurredOn: parseIsoDate(toStr(row.traded_on)),
    direction: toStr(row.direction) as FlowDirection,
    amount: Money.fromCents(toBigIntCents(row.amount_cents)),
    counterpartyName: toStr(row.counterparty),
    remark: toStrOrNull(row.remark),
  };
  return BankTransaction.rehydrate(snap);
}
