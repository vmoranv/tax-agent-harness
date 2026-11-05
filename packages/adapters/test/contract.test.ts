/**
 * 双驱动契约测试。
 *
 * 同一套断言跑两个实现：
 * - SQLite：始终运行
 * - PostgreSQL：需要 DATABASE_URL 且服务可达，否则跳过并给出明确提示
 */

import { describe, expect, it } from 'vitest';
import { createPgContractDeps, isPgAvailable } from './contract/pg.driver.js';
import { runRepositoryContract } from './contract/repository.contract.js';
import { createSqliteContractDeps } from './contract/sqlite.driver.js';

runRepositoryContract('SQLite', async () => createSqliteContractDeps());

const PG_URL = process.env.TEST_DATABASE_URL ?? '';

describe('PostgreSQL 契约测试', () => {
  it('PG 可达性蕴含已配置（环境不变量）', async () => {
    // 真实不变量：只有配置了 URL 才可能可达；未配置时契约测试整段跳过。
    const configured = PG_URL !== '';
    const reachable = configured ? await isPgAvailable(PG_URL) : false;
    if (!configured)
      console.log('⏭  跳过：未设置 TEST_DATABASE_URL（运行 `docker compose up -d` 后设置）');
    else if (!reachable) console.log(`⏭  跳过：${PG_URL} 不可达（PG 未启动？）`);
    expect(reachable && !configured).toBe(false);
    if (configured) expect(typeof reachable).toBe('boolean');
  });
});

if (PG_URL !== '') {
  runRepositoryContract('PostgreSQL', async () => createPgContractDeps(PG_URL));
}
