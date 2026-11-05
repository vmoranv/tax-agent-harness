import type { InvoiceRepository } from '@harness/contracts';
import type { EnterpriseId, InvoiceSnapshot, Month } from '@harness/domain';
import {
  enterpriseId,
  Invoice,
  InvoiceId,
  Money,
  parseIsoDate,
  invoiceNo as toInvoiceNo,
  userId as toUserId,
} from '@harness/domain';
import {
  fromBigIntCents,
  type SqlDatabase,
  toBigIntCents,
  toInt,
  toStr,
  toStrOrNull,
} from '../database.js';

const COLS = `enterprise_id, invoice_no, issued_on, seller_name, item_name,
              amount_cents, purpose, remark, version, updated_at, updated_by`;

export class SqlInvoiceRepository implements InvoiceRepository {
  constructor(private readonly db: SqlDatabase) {}

  async findById(id: InvoiceId): Promise<Invoice | null> {
    const row = this.db
      .prepare(`SELECT ${COLS} FROM invoice WHERE enterprise_id = ? AND invoice_no = ?`)
      .get(id.enterpriseId, id.invoiceNo);
    return row === undefined ? null : toInvoice(row);
  }

  async listByMonth(e: EnterpriseId, m: Month): Promise<Invoice[]> {
    const rows = this.db
      .prepare(
        `SELECT ${COLS} FROM invoice
         WHERE enterprise_id = ? AND issued_month = ?
         ORDER BY invoice_no`,
      )
      .all(e, m);
    return rows.map(toInvoice);
  }

  async listMissingPurpose(e: EnterpriseId, m: Month): Promise<Invoice[]> {
    const rows = this.db
      .prepare(
        `SELECT ${COLS} FROM invoice
         WHERE enterprise_id = ? AND issued_month = ?
           AND (purpose IS NULL OR trim(purpose) = '')
         ORDER BY invoice_no`,
      )
      .all(e, m);
    return rows.map(toInvoice);
  }

  /**
   * 乐观锁写入。
   * `WHERE version = ?` 不匹配时 `changes === 0` → 返回 false。
   */
  async save(invoice: Invoice, expectedVersion: number): Promise<boolean> {
    const r = this.db
      .prepare(
        `UPDATE invoice
            SET purpose = ?, remark = ?, version = version + 1,
                updated_at = ?, updated_by = ?
          WHERE enterprise_id = ? AND invoice_no = ? AND version = ?`,
      )
      .run(
        invoice.purpose,
        invoice.remark,
        invoice.updatedAt,
        invoice.updatedBy,
        invoice.enterpriseId,
        invoice.invoiceNo,
        expectedVersion,
      );
    return r.changes > 0;
  }

  async bulkUpsert(invoices: readonly Invoice[]): Promise<number> {
    const stmt = this.db.prepare(
      `INSERT INTO invoice (${COLS}, issued_month)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (enterprise_id, invoice_no) DO UPDATE SET
         issued_on = excluded.issued_on,
         issued_month = excluded.issued_month,
         seller_name = excluded.seller_name,
         item_name = excluded.item_name,
         amount_cents = excluded.amount_cents,
         purpose = excluded.purpose,
         remark = excluded.remark,
         version = excluded.version,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    );
    let n = 0;
    for (const inv of invoices) {
      const s = inv.snapshot();
      stmt.run(
        s.enterpriseId,
        s.invoiceNo,
        s.issuedOn,
        s.sellerName,
        s.itemName,
        fromBigIntCents(s.amount.cents),
        s.purpose,
        s.remark,
        s.version,
        s.updatedAt,
        s.updatedBy,
        s.issuedOn.slice(0, 7),
      );
      n += 1;
    }
    return n;
  }
}

function toInvoice(row: Record<string, unknown>): Invoice {
  const snap: InvoiceSnapshot = {
    id: InvoiceId.of(toStr(row.enterprise_id), toStr(row.invoice_no)),
    enterpriseId: enterpriseId(toStr(row.enterprise_id)),
    invoiceNo: toInvoiceNo(toStr(row.invoice_no)),
    issuedOn: parseIsoDate(toStr(row.issued_on)),
    sellerName: toStr(row.seller_name),
    itemName: toStr(row.item_name),
    amount: Money.fromCents(toBigIntCents(row.amount_cents)),
    purpose: toStrOrNull(row.purpose),
    remark: toStrOrNull(row.remark),
    version: toInt(row.version),
    updatedAt: parseIsoDate(toStr(row.updated_at)),
    updatedBy: toUserId(toStr(row.updated_by)),
  };
  return Invoice.rehydrate(snap);
}
