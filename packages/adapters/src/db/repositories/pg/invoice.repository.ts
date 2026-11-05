/**
 * 发票仓储（PostgreSQL / Drizzle）。
 *
 * 两个关键语义：
 * 1. **乐观锁**：`UPDATE ... WHERE version = ?`，`rowCount === 0` 即冲突
 * 2. **按月查询不依赖冗余列**：用 `date_trunc('month', issued_on)` 表达式，
 *    对应 schema 里的表达式索引（3NF 的代价由索引承担，而非冗余字段）
 */

import type { InvoiceRepository } from '@harness/contracts';
import {
  type EnterpriseId,
  Invoice,
  InvoiceId,
  type InvoiceSnapshot,
  Money,
  type Month,
  parseIsoDate,
  enterpriseId as toEnterpriseId,
  invoiceNo as toInvoiceNo,
  userId as toUserId,
} from '@harness/domain';
import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase } from '../../pg-client.js';
import { invoice } from '../../schema/pg.schema.js';

type Row = typeof invoice.$inferSelect;

export class PgInvoiceRepository implements InvoiceRepository {
  constructor(private readonly db: PgDatabase) {}

  async findById(id: InvoiceId): Promise<Invoice | null> {
    const rows = await this.db
      .select()
      .from(invoice)
      .where(and(eq(invoice.enterpriseId, id.enterpriseId), eq(invoice.invoiceNo, id.invoiceNo)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toDomain(row);
  }

  async listByMonth(e: EnterpriseId, m: Month): Promise<Invoice[]> {
    const rows = await this.db
      .select()
      .from(invoice)
      .where(
        and(
          eq(invoice.enterpriseId, e),
          sql`date_trunc('month', ${invoice.issuedOn}) = ${`${m}-01`}::date`,
        ),
      )
      .orderBy(invoice.invoiceNo);
    return rows.map(toDomain);
  }

  async listMissingPurpose(e: EnterpriseId, m: Month): Promise<Invoice[]> {
    const rows = await this.db
      .select()
      .from(invoice)
      .where(
        and(
          eq(invoice.enterpriseId, e),
          sql`date_trunc('month', ${invoice.issuedOn}) = ${`${m}-01`}::date`,
          sql`(${invoice.purpose} IS NULL OR btrim(${invoice.purpose}) = '')`,
        ),
      )
      .orderBy(invoice.invoiceNo);
    return rows.map(toDomain);
  }

  /** 乐观锁写入：版本不符时 rowCount 为 0。 */
  async save(inv: Invoice, expectedVersion: number): Promise<boolean> {
    const result = await this.db
      .update(invoice)
      .set({
        purpose: inv.purpose,
        remark: inv.remark,
        version: sql`${invoice.version} + 1`,
        updatedAt: new Date(inv.updatedAt),
        updatedBy: inv.updatedBy,
      })
      .where(
        and(
          eq(invoice.enterpriseId, inv.enterpriseId),
          eq(invoice.invoiceNo, inv.invoiceNo),
          eq(invoice.version, expectedVersion),
        ),
      );
    return (result.rowCount ?? 0) > 0;
  }

  async bulkUpsert(invoices: readonly Invoice[]): Promise<number> {
    if (invoices.length === 0) return 0;
    const values = invoices.map((inv) => {
      const s = inv.snapshot();
      return {
        enterpriseId: s.enterpriseId as string,
        invoiceNo: s.invoiceNo as string,
        issuedOn: s.issuedOn as string,
        sellerName: s.sellerName,
        itemName: s.itemName,
        amountCents: s.amount.cents,
        purpose: s.purpose,
        remark: s.remark,
        version: s.version,
        updatedAt: new Date(s.updatedAt),
        updatedBy: s.updatedBy as string,
      };
    });

    await this.db
      .insert(invoice)
      .values(values)
      .onConflictDoUpdate({
        target: [invoice.enterpriseId, invoice.invoiceNo],
        set: {
          purpose: sql`excluded.purpose`,
          remark: sql`excluded.remark`,
          version: sql`excluded.version`,
          updatedAt: sql`excluded.updated_at`,
          updatedBy: sql`excluded.updated_by`,
        },
      });

    return invoices.length;
  }
}

function toDomain(row: Row): Invoice {
  const snap: InvoiceSnapshot = {
    id: InvoiceId.of(row.enterpriseId, row.invoiceNo),
    enterpriseId: toEnterpriseId(row.enterpriseId),
    invoiceNo: toInvoiceNo(row.invoiceNo),
    issuedOn: parseIsoDate(toIsoDateString(row.issuedOn)),
    sellerName: row.sellerName,
    itemName: row.itemName,
    amount: Money.fromCents(BigInt(row.amountCents)),
    purpose: row.purpose,
    remark: row.remark,
    version: row.version,
    updatedAt: parseIsoDate(toIsoDateString(row.updatedAt)),
    updatedBy: toUserId(row.updatedBy),
  };
  return Invoice.rehydrate(snap);
}

/** `date` 列在 drizzle 里可能是 string 或 Date，统一成 YYYY-MM-DD。 */
function toIsoDateString(v: string | Date): string {
  if (typeof v === 'string') return v.slice(0, 10);
  const y = v.getUTCFullYear();
  const m = String(v.getUTCMonth() + 1).padStart(2, '0');
  const d = String(v.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
