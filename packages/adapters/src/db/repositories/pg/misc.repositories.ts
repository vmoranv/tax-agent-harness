/**
 * 其余 PG 仓储。
 *
 * 拆分说明：`invoice` / `bank` / `rule` / `task-card` 各自成文件（它们承载
 * 乐观锁、只读、谓词联表、条目聚合等复杂语义）；这里只放「单表 CRUD」类的仓储。
 *
 * 每个类都很薄 —— 因为复杂度在 schema 与领域层，不在映射。
 */

import type {
  AccessGrantRepository,
  EnterpriseRepository,
  InvoiceWriteLogEntry,
  InvoiceWriteLogRepository,
  MemoryRecordRepository,
  MessageRole,
  SessionRecord,
  SessionRepository,
  StoredMessage,
  UserRepository,
} from '@harness/contracts';
import {
  type AccessGrant,
  type AccessLevel,
  accessGrant,
  Enterprise,
  type EnterpriseId,
  type Enterprise as EnterpriseT,
  enterpriseName,
  MemoryRecord,
  type MemoryRecordSnapshot,
  type MemoryRecord as MemoryRecordT,
  Money,
  parseIsoDate,
  enterpriseId as toEnterpriseId,
  userId as toUserId,
  UserAccount,
  type UserAccount as UserAccountT,
  type UserId,
} from '@harness/domain';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PgDatabase } from '../../pg-client.js';
import {
  appUser,
  conversation,
  conversationMessage,
  enterprise,
  enterpriseAlias,
  accessGrant as grantTable,
  invoiceWriteLog,
  preference,
} from '../../schema/pg.schema.js';

/* ------------------------------ 企业 ------------------------------ */

export class PgEnterpriseRepository implements EnterpriseRepository {
  constructor(private readonly db: PgDatabase) {}

  async findById(id: EnterpriseId): Promise<EnterpriseT | null> {
    const rows = await this.db.select().from(enterprise).where(eq(enterprise.id, id)).limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const aliases = await this.db
      .select()
      .from(enterpriseAlias)
      .where(eq(enterpriseAlias.enterpriseId, id));
    return Enterprise.rehydrate({
      id: toEnterpriseId(row.id),
      legalName: enterpriseName(row.legalName),
      aliases: aliases.map((a) => a.alias),
      status: row.status as 'active' | 'inactive',
      version: row.version,
    });
  }

  async listAll(): Promise<EnterpriseT[]> {
    const rows = await this.db.select().from(enterprise).orderBy(enterprise.id);
    const out: EnterpriseT[] = [];
    for (const row of rows) {
      const e = await this.findById(toEnterpriseId(row.id));
      if (e !== null) out.push(e);
    }
    return out;
  }

  async resolveByName(name: string): Promise<EnterpriseT | null> {
    const all = await this.listAll();
    return all.find((e) => e.legalName === name || e.aliasesFor().includes(name)) ?? null;
  }
}

/* ------------------------------ 用户 ------------------------------ */

export class PgUserRepository implements UserRepository {
  constructor(private readonly db: PgDatabase) {}

  async findById(id: UserId): Promise<UserAccountT | null> {
    const rows = await this.db.select().from(appUser).where(eq(appUser.id, id)).limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const grants = await this.loadGrants(row.id);
    return UserAccount.rehydrate({
      id: toUserId(row.id),
      displayName: row.displayName,
      status: row.status as 'active' | 'disabled',
      grants,
      version: row.version,
    });
  }

  async listAll(): Promise<UserAccountT[]> {
    const rows = await this.db.select().from(appUser).orderBy(appUser.id);
    return Promise.all(
      rows.map(async (row) =>
        UserAccount.rehydrate({
          id: toUserId(row.id),
          displayName: row.displayName,
          status: row.status as 'active' | 'disabled',
          grants: await this.loadGrants(row.id),
          version: row.version,
        }),
      ),
    );
  }

  private async loadGrants(userId: string): Promise<AccessGrant[]> {
    const rows = await this.db.select().from(grantTable).where(eq(grantTable.userId, userId));
    return rows.map(toGrant);
  }
}

function toGrant(r: typeof grantTable.$inferSelect): AccessGrant {
  return accessGrant({
    enterpriseId: toEnterpriseId(r.enterpriseId),
    level: r.accessLevel as AccessLevel,
    grantedAt: parseIsoDate(toIso(r.grantedAt)),
    grantedBy: r.grantedBy === 'system' ? 'system' : toUserId(r.grantedBy),
  });
}

/* ------------------------------ 授权 ------------------------------ */

export class PgGrantRepository implements AccessGrantRepository {
  constructor(private readonly db: PgDatabase) {}

  async find(userId: UserId, enterpriseId: EnterpriseId): Promise<AccessGrant | null> {
    const rows = await this.db
      .select()
      .from(grantTable)
      .where(and(eq(grantTable.userId, userId), eq(grantTable.enterpriseId, enterpriseId)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toGrant(row);
  }

  async listByUser(userId: UserId): Promise<AccessGrant[]> {
    const rows = await this.db.select().from(grantTable).where(eq(grantTable.userId, userId));
    return rows.map(toGrant);
  }
}

/* ------------------------------ 偏好 ------------------------------ */

export class PgPreferenceRepository implements MemoryRecordRepository {
  constructor(private readonly db: PgDatabase) {}

  async list(userId: UserId, enterpriseId: EnterpriseId): Promise<MemoryRecordT[]> {
    const rows = await this.db
      .select()
      .from(preference)
      .where(and(eq(preference.userId, userId), eq(preference.enterpriseId, enterpriseId)));
    return rows.map((r) => toMemoryRecord(r, userId, enterpriseId));
  }

  async find(
    userId: UserId,
    enterpriseId: EnterpriseId,
    key: string,
  ): Promise<MemoryRecordT | null> {
    const rows = await this.db
      .select()
      .from(preference)
      .where(
        and(
          eq(preference.userId, userId),
          eq(preference.enterpriseId, enterpriseId),
          eq(preference.key, key),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toMemoryRecord(row, userId, enterpriseId);
  }

  async upsert(record: MemoryRecordT): Promise<void> {
    const s = record.toSnapshot();
    await this.db
      .insert(preference)
      .values({
        userId: s.userId,
        enterpriseId: s.enterpriseId,
        key: s.key,
        value: s.value,
        updatedAt: new Date(s.updatedAt),
      })
      .onConflictDoUpdate({
        target: [preference.userId, preference.enterpriseId, preference.key],
        set: {
          value: sql`excluded.value`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  async delete(userId: UserId, enterpriseId: EnterpriseId, key: string): Promise<boolean> {
    const r = await this.db
      .delete(preference)
      .where(
        and(
          eq(preference.userId, userId),
          eq(preference.enterpriseId, enterpriseId),
          eq(preference.key, key),
        ),
      );
    return (r.rowCount ?? 0) > 0;
  }
}

function toMemoryRecord(
  r: typeof preference.$inferSelect,
  userId: UserId,
  enterpriseId: EnterpriseId,
): MemoryRecordT {
  const snap: MemoryRecordSnapshot = {
    id: `${userId}:${enterpriseId}:${r.key}`,
    userId,
    enterpriseId,
    kind: 'preference',
    key: r.key,
    value: r.value,
    version: 0,
    supersededBy: null,
    source: { kind: 'user-stated' },
    createdAt: parseIsoDate(toIso(r.updatedAt)),
    updatedAt: parseIsoDate(toIso(r.updatedAt)),
  };
  return MemoryRecord.rehydrate(snap);
}

/* ---------------------------- 写入日志 ---------------------------- */

export class PgWriteLogRepository implements InvoiceWriteLogRepository {
  constructor(private readonly db: PgDatabase) {}

  async append(entry: InvoiceWriteLogEntry): Promise<void> {
    await this.db.insert(invoiceWriteLog).values({
      enterpriseId: entry.enterpriseId,
      invoiceNo: entry.invoiceNo,
      field: entry.field,
      oldValue: entry.oldValue,
      newValue: entry.newValue,
      runId: entry.runId,
      toolCallId: entry.toolCallId,
      actor: entry.actor,
      createdAt: new Date(entry.createdAt),
    });
  }

  async hasWritten(
    runId: string,
    enterpriseId: string,
    invoiceNo: string,
    field: 'purpose' | 'remark',
    newValue: string,
  ): Promise<boolean> {
    const rows = await this.db
      .select({ id: invoiceWriteLog.id })
      .from(invoiceWriteLog)
      .where(
        and(
          eq(invoiceWriteLog.runId, runId),
          eq(invoiceWriteLog.enterpriseId, enterpriseId),
          eq(invoiceWriteLog.invoiceNo, invoiceNo),
          eq(invoiceWriteLog.field, field),
          eq(invoiceWriteLog.newValue, newValue),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async listByRun(runId: string): Promise<InvoiceWriteLogEntry[]> {
    const rows = await this.db
      .select()
      .from(invoiceWriteLog)
      .where(eq(invoiceWriteLog.runId, runId))
      .orderBy(invoiceWriteLog.id);
    return rows.map((r) => ({
      enterpriseId: r.enterpriseId,
      invoiceNo: r.invoiceNo,
      field: r.field as 'purpose' | 'remark',
      oldValue: r.oldValue,
      newValue: r.newValue,
      runId: r.runId,
      toolCallId: r.toolCallId,
      actor: r.actor,
      createdAt: toIso(r.createdAt),
    }));
  }
}

/* ------------------------------ 会话 ------------------------------ */

export class PgSessionRepository implements SessionRepository {
  constructor(private readonly db: PgDatabase) {}

  async findOrCreate(
    userId: UserId,
    enterpriseId: EnterpriseId,
    now: string,
  ): Promise<SessionRecord> {
    const existing = await this.db
      .select()
      .from(conversation)
      .where(and(eq(conversation.userId, userId), eq(conversation.enterpriseId, enterpriseId)))
      .orderBy(desc(conversation.lastActiveAt))
      .limit(1);

    const row = existing[0];
    if (row !== undefined) return toSession(row);

    const id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const at = new Date(now);
    await this.db.insert(conversation).values({
      id,
      userId,
      enterpriseId,
      createdAt: at,
      lastActiveAt: at,
    });
    return { id, userId, enterpriseId, createdAt: now, lastActiveAt: now };
  }

  async findById(sessionId: string): Promise<SessionRecord | null> {
    const rows = await this.db
      .select()
      .from(conversation)
      .where(eq(conversation.id, sessionId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toSession(row);
  }

  async appendMessage(
    sessionId: string,
    role: MessageRole,
    content: string,
    now: string,
  ): Promise<StoredMessage> {
    // 取当前最大 seq 再 +1；并发下由唯一索引 (conversation_id, seq) 兜底
    const maxRows = await this.db
      .select({ seq: sql<number>`coalesce(max(${conversationMessage.seq}), 0)` })
      .from(conversationMessage)
      .where(eq(conversationMessage.conversationId, sessionId));
    const nextSeq = Number(maxRows[0]?.seq ?? 0) + 1;

    const inserted = await this.db
      .insert(conversationMessage)
      .values({
        conversationId: sessionId,
        seq: nextSeq,
        role,
        content,
        createdAt: new Date(now),
      })
      .returning({ id: conversationMessage.id });

    return {
      id: Number(inserted[0]?.id ?? 0),
      sessionId,
      role,
      content,
      createdAt: now,
    };
  }

  async listMessages(sessionId: string, limit: number): Promise<StoredMessage[]> {
    const rows = await this.db
      .select()
      .from(conversationMessage)
      .where(eq(conversationMessage.conversationId, sessionId))
      .orderBy(desc(conversationMessage.seq))
      .limit(limit);
    return rows.reverse().map((r) => ({
      id: Number(r.id),
      sessionId: r.conversationId,
      role: r.role as MessageRole,
      content: r.content,
      createdAt: toIso(r.createdAt),
    }));
  }

  async touch(sessionId: string, now: string): Promise<void> {
    await this.db
      .update(conversation)
      .set({ lastActiveAt: new Date(now) })
      .where(eq(conversation.id, sessionId));
  }
}

function toSession(r: typeof conversation.$inferSelect): SessionRecord {
  return {
    id: r.id,
    userId: r.userId,
    enterpriseId: r.enterpriseId,
    createdAt: toIso(r.createdAt),
    lastActiveAt: toIso(r.lastActiveAt),
  };
}

/* ------------------------------ 工具 ------------------------------ */

function toIso(v: Date | string): string {
  return typeof v === 'string' ? v : v.toISOString();
}

export { Money };
