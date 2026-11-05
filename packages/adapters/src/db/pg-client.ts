/**
 * PostgreSQL 客户端。
 *
 * 用 `pg` 连接池：API 与 Worker 各自持有一个池，
 * 扩容时每个实例独立建连，由 PG 侧协调。
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/pg.schema.js';

export type PgDatabase = ReturnType<typeof createPgDb>['db'];

export interface PgHandle {
  readonly db: ReturnType<typeof drizzle<typeof schema>>;
  readonly pool: Pool;
  close(): Promise<void>;
}

export function createPgDb(connectionString: string, maxConnections = 10): PgHandle {
  const pool = new Pool({
    connectionString,
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    close: async (): Promise<void> => {
      await pool.end();
    },
  };
}
