/**
 * 种子数据装载。
 *
 * 从 bootstrap 拆出：这是「一次性初始化」，与「每轮装配」的生命周期完全不同。
 *
 * 顺序很重要：**先核对再落库**。数据不一致时整批回滚，
 * 绝不把错数据放进系统。
 */

import { loadAll, type SqlDatabase } from '@harness/adapters';
import { log } from '@harness/runtime';

export interface SeedOptions {
  readonly xlsx: string;
  readonly rules: string;
}

export interface SeedResult {
  readonly enterprises: number;
  readonly users: number;
  readonly invoices: number;
  readonly bankTransactions: number;
  readonly rules: number;
  readonly matched: boolean;
}

export async function seedFromXlsx(db: SqlDatabase, opts: SeedOptions): Promise<SeedResult> {
  const loaded = await loadAll(db, opts.xlsx, opts.rules);

  log.info(
    `装载完成：企业 ${loaded.enterprises} 用户 ${loaded.users} ` +
      `发票 ${loaded.invoices} 流水 ${loaded.bankTransactions} 规则 ${loaded.rules}；` +
      `核对${loaded.verification.matched ? '通过' : '失败'}`,
  );

  if (!loaded.verification.matched) {
    throw new Error(`数据核对失败：${JSON.stringify(loaded.verification.diffs, null, 2)}`);
  }

  return {
    enterprises: loaded.enterprises,
    users: loaded.users,
    invoices: loaded.invoices,
    bankTransactions: loaded.bankTransactions,
    rules: loaded.rules,
    matched: loaded.verification.matched,
  };
}
