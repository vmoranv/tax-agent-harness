/**
 * SQLite 驱动入口（本地开发 / CI 快跑）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type SqlDatabase } from '../../src/sqlite/database.js';
import { SqliteUnitOfWork } from '../../src/sqlite/unit-of-work.js';
import type { ContractDeps } from './repository.contract.js';

export async function createSqliteContractDeps(): Promise<ContractDeps & { db: SqlDatabase }> {
  const dir = mkdtempSync(join(tmpdir(), 'harness-contract-'));
  const db = openDatabase(join(dir, 'contract.db'));
  const uow = new SqliteUnitOfWork(db);

  return {
    db,
    run: <T>(fn: Parameters<typeof uow.run<T>>[0]) => uow.run(fn),
    teardown: async (): Promise<void> => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
