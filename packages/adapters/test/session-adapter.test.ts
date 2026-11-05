import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionAdapter } from '../src/session-adapter.js';
import { openDatabase, type SqlDatabase } from '../src/sqlite/database.js';
import { SqliteUnitOfWork } from '../src/sqlite/unit-of-work.js';

let dir: string;
let db: SqlDatabase;
let adapter: ReturnType<typeof createSessionAdapter>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-session-'));
  db = openDatabase(join(dir, 'test.db'));
  adapter = createSessionAdapter(new SqliteUnitOfWork(db));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('评测隔离会话（data leakage 修复）', () => {
  it('eval-* sessionKey 的 history 恒为空', async () => {
    // 先在默认会话里写一条含答案的历史，制造"污染"
    const defaultKey = 'api:http:U001-C001';
    await adapter.append(defaultKey, 'assistant', '甲企业 2026-09 价税合计 9,622.06 元');
    expect((await adapter.history(defaultKey, 40)).length).toBeGreaterThan(0);

    // 评测隔离会话读不到任何历史
    const evalKey = 'api:http:eval-run1-S05';
    expect(await adapter.history(evalKey, 40)).toEqual([]);
  });

  it('eval-* sessionKey 的 append 不落库，不污染默认会话', async () => {
    const defaultKey = 'api:http:U001-C001';
    const before = (await adapter.history(defaultKey, 40)).length;

    await adapter.append('api:http:eval-run1-S05', 'assistant', '9,622.06 元（评测答案）');

    // 默认会话历史条数不变
    expect((await adapter.history(defaultKey, 40)).length).toBe(before);
  });

  it('默认会话仍正常多轮读写（线上行为不变）', async () => {
    const key = 'api:http:U002-C002';
    await adapter.append(key, 'user', '查一下金额');
    await adapter.append(key, 'assistant', '请确认企业');
    const hist = await adapter.history(key, 40);
    expect(hist.map((m) => m.content)).toEqual(['查一下金额', '请确认企业']);
  });
});
