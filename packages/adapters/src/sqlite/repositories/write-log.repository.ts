import type { InvoiceWriteLogEntry, InvoiceWriteLogRepository } from '@harness/contracts';
import { type SqlDatabase, toStr, toStrOrNull } from '../database.js';

export class SqlWriteLogRepository implements InvoiceWriteLogRepository {
  constructor(private readonly db: SqlDatabase) {}

  async append(entry: InvoiceWriteLogEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO invoice_write_log
           (enterprise_id, invoice_no, field, old_value, new_value, run_id, tool_call_id, actor, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        entry.enterpriseId,
        entry.invoiceNo,
        entry.field,
        entry.oldValue,
        entry.newValue,
        entry.runId,
        entry.toolCallId,
        entry.actor,
        entry.createdAt,
      );
  }

  async hasWritten(
    runId: string,
    enterpriseId: string,
    invoiceNo: string,
    field: 'purpose' | 'remark',
    newValue: string,
  ): Promise<boolean> {
    const r = this.db
      .prepare(
        `SELECT 1 FROM invoice_write_log
          WHERE run_id = ? AND enterprise_id = ? AND invoice_no = ? AND field = ? AND new_value = ?
          LIMIT 1`,
      )
      .get(runId, enterpriseId, invoiceNo, field, newValue);
    return r !== undefined;
  }

  async listByRun(runId: string): Promise<InvoiceWriteLogEntry[]> {
    return this.db
      .prepare(
        `SELECT enterprise_id, invoice_no, field, old_value, new_value, run_id, tool_call_id, actor, created_at
           FROM invoice_write_log WHERE run_id = ? ORDER BY id`,
      )
      .all(runId)
      .map((r) => ({
        enterpriseId: toStr(r.enterprise_id),
        invoiceNo: toStr(r.invoice_no),
        field: toStr(r.field) as 'purpose' | 'remark',
        oldValue: toStrOrNull(r.old_value),
        newValue: toStr(r.new_value),
        runId: toStr(r.run_id),
        toolCallId: toStr(r.tool_call_id),
        actor: toStr(r.actor),
        createdAt: toStr(r.created_at),
      }));
  }
}
