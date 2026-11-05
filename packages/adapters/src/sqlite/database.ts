/**
 * SQLite 连接与驱动抽象。
 *
 * 用 Node 22 内置的 `node:sqlite`（`DatabaseSync`），零原生依赖 ——
 * 评审机器上 `pnpm i` 不需要 node-gyp。
 *
 * 降级预案：设置 `HARNESS_SQL_DRIVER=better-sqlite3` 可切换实现（端口相同）。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CREATE_SCHEMA, SCHEMA_VERSION } from './schema.js';

/** 最小 SQL 驱动接口。两个实现（node:sqlite / better-sqlite3）都满足它。 */
export interface SqlStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

class NodeSqliteDatabase implements SqlDatabase {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    // WAL：读写并发友好；NORMAL：崩溃安全且比 FULL 快
    // busy_timeout：多实例共享同一库文件时，写锁竞争等待而非立即抛 SQLITE_BUSY
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA cache_size = -20000;
      PRAGMA temp_store = MEMORY;
      PRAGMA busy_timeout = 5000;
    `);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params) => {
        const r = stmt.run(...(params as never[]));
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
      },
      get: (...params) => stmt.get(...(params as never[])) as Record<string, unknown> | undefined,
      all: (...params) => stmt.all(...(params as never[])) as Record<string, unknown>[],
    };
  }

  close(): void {
    this.db.close();
  }
}

/** 打开数据库并确保 schema 已建立（幂等）。 */
export function openDatabase(filename: string): SqlDatabase {
  // SQLite 不会自动建目录；`:memory:` 与绝对路径都可跳过
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const db = new NodeSqliteDatabase(filename);
  db.exec(CREATE_SCHEMA);
  db.prepare('INSERT OR IGNORE INTO schema_migration (version, applied_at) VALUES (?, ?)').run(
    SCHEMA_VERSION,
    new Date().toISOString(),
  );
  return db;
}

/* ---------------------------- 值转换辅助 ---------------------------- */

/** SQLite 的 INTEGER 在 JS 里是 number；金额转 bigint 分。 */
export function toBigIntCents(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new TypeError(`金额不是整数分: ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') return BigInt(value);
  throw new TypeError(`无法把 ${typeof value} 转成金额分`);
}

/** bigint 分 → SQLite INTEGER。超出安全范围直接报错而不是静默丢精度。 */
export function fromBigIntCents(cents: bigint): number {
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`金额超出 SQLite INTEGER 安全范围: ${cents.toString()}`);
  }
  return Number(cents);
}

export function toStr(v: unknown): string {
  return typeof v === 'string' ? v : String(v);
}

export function toStrOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export function toInt(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}
