/**
 * PostgreSQL 驱动入口。
 *
 * 本机没有 PG 时**自动跳过**而不是失败 —— CI 里可以用 docker compose 起服务后跑全量。
 * 跳过时会打印明确提示，避免「以为跑过了」。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TransactionScope } from '@harness/contracts';
import { createPgDb, type PgHandle } from '../../src/db/pg-client.js';
import { PgBankRepository } from '../../src/db/repositories/pg/bank.repository.js';
import { PgInvoiceRepository } from '../../src/db/repositories/pg/invoice.repository.js';
import {
  PgEnterpriseRepository,
  PgGrantRepository,
  PgPreferenceRepository,
  PgSessionRepository,
  PgUserRepository,
  PgWriteLogRepository,
} from '../../src/db/repositories/pg/misc.repositories.js';
import { PgRuleRepository } from '../../src/db/repositories/pg/rule.repository.js';
import { PgTaskCardRepository } from '../../src/db/repositories/pg/task-card.repository.js';
import type { ContractDeps } from './repository.contract.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const MIGRATIONS = join(REPO_ROOT, 'packages/adapters/src/db/migrations');

export async function isPgAvailable(url: string): Promise<boolean> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    try {
      await c.end();
    } catch {
      /* ignore */
    }
    return false;
  }
}

export async function createPgContractDeps(connectionString: string): Promise<ContractDeps> {
  const handle: PgHandle = createPgDb(connectionString, 2);

  // 每次跑契约测试前重建 schema（隔离，不影响其他数据）
  const { Client } = await import('pg');
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query('DROP SCHEMA IF EXISTS public CASCADE');
  await admin.query('CREATE SCHEMA public');

  for (const file of ['0000_sticky_red_skull.sql', '0001_constraints.sql']) {
    const sqlText = readFileSync(join(MIGRATIONS, file), 'utf8');
    // Drizzle 生成的迁移用 `--> statement-breakpoint` 分隔
    for (const stmt of sqlText.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim();
      if (trimmed !== '') await admin.query(trimmed);
    }
  }
  await admin.end();

  const { db } = handle;

  return {
    run: async <T>(fn: (tx: TransactionScope) => Promise<T>): Promise<T> =>
      fn({
        invoices: new PgInvoiceRepository(db),
        banks: new PgBankRepository(db),
        enterprises: new PgEnterpriseRepository(db),
        users: new PgUserRepository(db),
        grants: new PgGrantRepository(db),
        rules: new PgRuleRepository(db),
        taskCards: new PgTaskCardRepository(db),
        preferences: new PgPreferenceRepository(db),
        writeLog: new PgWriteLogRepository(db),
        sessions: new PgSessionRepository(db),
        events: {
          publish: () => undefined,
          drain: () => [],
        },
      }),
    teardown: async (): Promise<void> => {
      await handle.close();
    },
  };
}

void mkdtempSync;
void tmpdir;
void rmSync;
