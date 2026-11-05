import type {
  MessageRole,
  SessionRecord,
  SessionRepository,
  StoredMessage,
} from '@harness/contracts';
import type { EnterpriseId, UserId } from '@harness/domain';
import { type SqlDatabase, toInt, toStr } from '../database.js';

export class SqlSessionRepository implements SessionRepository {
  constructor(private readonly db: SqlDatabase) {}

  async findOrCreate(
    userId: UserId,
    enterpriseId: EnterpriseId,
    now: string,
  ): Promise<SessionRecord> {
    const existing = this.db
      .prepare(
        `SELECT id, user_id, enterprise_id, created_at, last_active_at
           FROM session WHERE user_id = ? AND enterprise_id = ?
           ORDER BY last_active_at DESC LIMIT 1`,
      )
      .get(userId, enterpriseId);
    if (existing !== undefined) return toSession(existing);

    const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        'INSERT INTO session (id, user_id, enterprise_id, created_at, last_active_at) VALUES (?,?,?,?,?)',
      )
      .run(id, userId, enterpriseId, now, now);
    return { id, userId, enterpriseId, createdAt: now, lastActiveAt: now };
  }

  async findById(sessionId: string): Promise<SessionRecord | null> {
    const r = this.db
      .prepare(
        'SELECT id, user_id, enterprise_id, created_at, last_active_at FROM session WHERE id = ?',
      )
      .get(sessionId);
    return r === undefined ? null : toSession(r);
  }

  async appendMessage(
    sessionId: string,
    role: MessageRole,
    content: string,
    now: string,
  ): Promise<StoredMessage> {
    const r = this.db
      .prepare('INSERT INTO message (session_id, role, content, created_at) VALUES (?,?,?,?)')
      .run(sessionId, role, content, now);
    return { id: Number(r.lastInsertRowid), sessionId, role, content, createdAt: now };
  }

  async listMessages(sessionId: string, limit: number): Promise<StoredMessage[]> {
    return this.db
      .prepare(
        'SELECT id, session_id, role, content, created_at FROM message WHERE session_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(sessionId, limit)
      .reverse()
      .map((r) => ({
        id: toInt(r.id),
        sessionId: toStr(r.session_id),
        role: toStr(r.role) as MessageRole,
        content: toStr(r.content),
        createdAt: toStr(r.created_at),
      }));
  }

  async touch(sessionId: string, now: string): Promise<void> {
    this.db.prepare('UPDATE session SET last_active_at = ? WHERE id = ?').run(now, sessionId);
  }
}

function toSession(r: Record<string, unknown>): SessionRecord {
  return {
    id: toStr(r.id),
    userId: toStr(r.user_id),
    enterpriseId: toStr(r.enterprise_id),
    createdAt: toStr(r.created_at),
    lastActiveAt: toStr(r.last_active_at),
  };
}
