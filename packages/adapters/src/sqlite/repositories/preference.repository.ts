import type { MemoryRecordRepository } from '@harness/contracts';
import type { EnterpriseId, MemoryRecord as MemoryRecordT, UserId } from '@harness/domain';
import { MemoryRecord, parseIsoDate } from '@harness/domain';
import { type SqlDatabase, toStr } from '../database.js';

export class SqlMemoryRecordRepository implements MemoryRecordRepository {
  constructor(private readonly db: SqlDatabase) {}

  async list(userId: UserId, enterpriseId: EnterpriseId): Promise<MemoryRecordT[]> {
    return this.db
      .prepare(
        'SELECT user_id, enterprise_id, key, value, updated_at FROM preference WHERE user_id = ? AND enterprise_id = ?',
      )
      .all(userId, enterpriseId)
      .map(toMemory);
  }

  async find(
    userId: UserId,
    enterpriseId: EnterpriseId,
    key: string,
  ): Promise<MemoryRecordT | null> {
    const r = this.db
      .prepare(
        'SELECT user_id, enterprise_id, key, value, updated_at FROM preference WHERE user_id = ? AND enterprise_id = ? AND key = ?',
      )
      .get(userId, enterpriseId, key);
    return r === undefined ? null : toMemory(r);
  }

  async upsert(record: MemoryRecordT): Promise<void> {
    const s = record.toSnapshot();
    this.db
      .prepare(
        `INSERT INTO preference (user_id, enterprise_id, key, value, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT (user_id, enterprise_id, key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(s.userId, s.enterpriseId, s.key, s.value, s.updatedAt);
  }

  async delete(userId: UserId, enterpriseId: EnterpriseId, key: string): Promise<boolean> {
    const r = this.db
      .prepare('DELETE FROM preference WHERE user_id = ? AND enterprise_id = ? AND key = ?')
      .run(userId, enterpriseId, key);
    return r.changes > 0;
  }
}

function toMemory(r: Record<string, unknown>): MemoryRecordT {
  return MemoryRecord.rehydrate({
    id: toStr(r.key),
    userId: toStr(r.user_id),
    enterpriseId: toStr(r.enterprise_id),
    kind: 'preference',
    key: toStr(r.key),
    value: toStr(r.value),
    version: 0,
    supersededBy: null,
    source: { kind: 'user-stated' },
    createdAt: parseIsoDate(toStr(r.updated_at)),
    updatedAt: parseIsoDate(toStr(r.updated_at)),
  });
}
