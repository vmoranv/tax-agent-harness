/**
 * 事务边界。
 *
 * 使用 `BEGIN IMMEDIATE` 而不是默认的 `BEGIN`：立即拿写锁，
 * 避免「先读后写」时的升级死锁。SQLite 单写者模型下这是正确选择。
 *
 * **绝不在事务内 await LLM** —— 用例层已经把 LLM 调用排除在 `uow.run` 之外。
 */

import type { DomainEventCollector, TransactionScope, UnitOfWork } from '@harness/contracts';
import type { SqlDatabase } from './database.js';
import { SqlBankRepository } from './repositories/bank.repository.js';
import { SqlEnterpriseRepository } from './repositories/enterprise.repository.js';
import { SqlGrantRepository } from './repositories/grant.repository.js';
import { SqlInvoiceRepository } from './repositories/invoice.repository.js';
import { SqlMemoryRecordRepository } from './repositories/preference.repository.js';
import { SqlRuleRepository } from './repositories/rule.repository.js';
import { SqlSessionRepository } from './repositories/session.repository.js';
import { SqlTaskCardRepository } from './repositories/task-card.repository.js';
import { SqlUserRepository } from './repositories/user.repository.js';
import { SqlWriteLogRepository } from './repositories/write-log.repository.js';

class BufferedEventCollector implements DomainEventCollector {
  private buffer: Array<{ type: string; [k: string]: unknown }> = [];

  publish(event: { type: string; [k: string]: unknown }): void {
    this.buffer.push(event);
  }

  drain(): ReadonlyArray<{ type: string; [k: string]: unknown }> {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }
}

export class SqliteUnitOfWork implements UnitOfWork {
  constructor(private readonly db: SqlDatabase) {}

  /** 嵌套深度：SQLite 不支持 BEGIN 嵌套，内层直接沿用外层事务。 */
  private depth = 0;

  async run<T>(fn: (tx: TransactionScope) => Promise<T>): Promise<T> {
    if (this.depth > 0) {
      // 已在事务内：复用外层事务，避免 "cannot start a transaction within a transaction"。
      // 语义是「参与同一事务」而非「独立子事务」—— 外层回滚会一并撤销内层写入。
      return fn(this.buildScope());
    }

    this.db.exec('BEGIN IMMEDIATE');
    this.depth += 1;
    const events = new BufferedEventCollector();
    try {
      const tx = this.buildScope(events);
      const result = await fn(tx);
      this.db.exec('COMMIT');
      this.depth -= 1;
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      this.depth -= 1;
      throw err;
    }
  }

  private buildScope(
    events: BufferedEventCollector = new BufferedEventCollector(),
  ): TransactionScope {
    return {
      invoices: new SqlInvoiceRepository(this.db),
      banks: new SqlBankRepository(this.db),
      enterprises: new SqlEnterpriseRepository(this.db),
      users: new SqlUserRepository(this.db),
      grants: new SqlGrantRepository(this.db),
      rules: new SqlRuleRepository(this.db),
      taskCards: new SqlTaskCardRepository(this.db),
      preferences: new SqlMemoryRecordRepository(this.db),
      writeLog: new SqlWriteLogRepository(this.db),
      sessions: new SqlSessionRepository(this.db),
      events,
    };
  }
}
