import type { TaskCardRepository } from '@harness/contracts';
import type {
  EnterpriseId,
  TaskCardSnapshot,
  TaskCard as TaskCardT,
  UserId,
} from '@harness/domain';
import { parseIsoDate, TaskCard } from '@harness/domain';
import { type SqlDatabase, toInt, toStr } from '../database.js';

export class SqlTaskCardRepository implements TaskCardRepository {
  constructor(private readonly db: SqlDatabase) {}

  async findActive(userId: UserId, enterpriseId: EnterpriseId): Promise<TaskCardT | null> {
    const r = this.db
      .prepare(
        `SELECT user_id, enterprise_id, month, status, payload, revision, updated_at
           FROM task_card WHERE user_id = ? AND enterprise_id = ? AND status = 'active'`,
      )
      .get(userId, enterpriseId);
    return r === undefined ? null : toTaskCard(r);
  }

  async save(card: TaskCardT, expectedRevision: number): Promise<boolean> {
    const s = card.toSnapshot();
    const updated = this.db
      .prepare(
        `UPDATE task_card SET month = ?, status = ?, payload = ?, revision = revision + 1, updated_at = ?
          WHERE user_id = ? AND enterprise_id = ? AND revision = ?`,
      )
      .run(
        s.month,
        s.status,
        JSON.stringify(s),
        s.updatedAt,
        s.userId,
        s.enterpriseId,
        expectedRevision,
      );
    if (updated.changes > 0) return true;

    // 首次插入（没有并发插同键的情况由唯一索引兜底）
    const exists = this.db
      .prepare('SELECT 1 FROM task_card WHERE user_id = ? AND enterprise_id = ? LIMIT 1')
      .get(s.userId, s.enterpriseId);
    if (exists !== undefined) return false;

    this.db
      .prepare(
        `INSERT INTO task_card (user_id, enterprise_id, month, status, payload, revision, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(s.userId, s.enterpriseId, s.month, s.status, JSON.stringify(s), s.revision, s.updatedAt);
    return true;
  }

  async listByScope(userId: UserId, enterpriseId: EnterpriseId): Promise<TaskCardT[]> {
    return this.db
      .prepare(
        `SELECT user_id, enterprise_id, month, status, payload, revision, updated_at
           FROM task_card WHERE user_id = ? AND enterprise_id = ?`,
      )
      .all(userId, enterpriseId)
      .map(toTaskCard);
  }
}

function toTaskCard(r: Record<string, unknown>): TaskCardT {
  const payload = JSON.parse(toStr(r.payload)) as Record<string, unknown>;
  return TaskCard.rehydrate({
    ...(payload as unknown as TaskCardSnapshot),
    revision: toInt(r.revision),
    updatedAt: parseIsoDate(toStr(r.updated_at)),
  });
}
