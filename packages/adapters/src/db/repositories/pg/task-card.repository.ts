/**
 * 任务卡仓储（PostgreSQL）。
 *
 * 头部与条目分表（1NF），读写时聚合还原。
 * 「每用户每企业最多一个进行中」由**部分唯一索引**保证，
 * 不是靠代码判断 —— 并发下代码判重会漏。
 */

import type { TaskCardRepository } from '@harness/contracts';
import {
  type EnterpriseId,
  parseIsoDate,
  parseMonth,
  TaskCard,
  type TaskCardSnapshot,
  type TaskCard as TaskCardT,
  type TaskItem,
  type TaskStatus,
  type UserId,
} from '@harness/domain';
import { and, eq } from 'drizzle-orm';
import type { PgDatabase } from '../../pg-client.js';
import { taskCard, taskItem } from '../../schema/pg.schema.js';

export class PgTaskCardRepository implements TaskCardRepository {
  constructor(private readonly db: PgDatabase) {}

  async findActive(userId: UserId, enterpriseId: EnterpriseId): Promise<TaskCardT | null> {
    const rows = await this.db
      .select()
      .from(taskCard)
      .where(
        and(
          eq(taskCard.userId, userId),
          eq(taskCard.enterpriseId, enterpriseId),
          eq(taskCard.status, 'active'),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;
    return this.loadWithItems(row);
  }

  async save(card: TaskCardT, expectedRevision: number): Promise<boolean> {
    const s = card.toSnapshot();

    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(taskCard)
        .set({
          month: s.month,
          status: s.status,
          note: s.note,
          revision: s.revision,
          updatedAt: new Date(s.updatedAt),
        })
        .where(
          and(
            eq(taskCard.userId, s.userId),
            eq(taskCard.enterpriseId, s.enterpriseId),
            eq(taskCard.revision, expectedRevision),
          ),
        );

      if ((updated.rowCount ?? 0) === 0) {
        // 判断是「不存在」还是「版本冲突」
        const exists = await tx
          .select({ userId: taskCard.userId })
          .from(taskCard)
          .where(and(eq(taskCard.userId, s.userId), eq(taskCard.enterpriseId, s.enterpriseId)))
          .limit(1);
        if (exists.length > 0) return false; // 版本冲突

        await tx.insert(taskCard).values({
          userId: s.userId,
          enterpriseId: s.enterpriseId,
          month: s.month,
          status: s.status,
          note: s.note,
          revision: s.revision,
          openedAt: new Date(s.openedAt),
          updatedAt: new Date(s.updatedAt),
        });
      }

      // 条目全量同步：先删后插（条目数很小，简单可靠）
      await tx
        .delete(taskItem)
        .where(and(eq(taskItem.userId, s.userId), eq(taskItem.enterpriseId, s.enterpriseId)));

      const items = [...s.pending, ...s.completed];
      if (items.length > 0) {
        await tx.insert(taskItem).values(
          items.map((it) => ({
            userId: s.userId,
            enterpriseId: s.enterpriseId,
            invoiceNo: it.ref as unknown as string,
            state: it.state,
            note: it.note,
            updatedAt: new Date(it.updatedAt),
          })),
        );
      }

      return true;
    });
  }

  async listByScope(userId: UserId, enterpriseId: EnterpriseId): Promise<TaskCardT[]> {
    const rows = await this.db
      .select()
      .from(taskCard)
      .where(and(eq(taskCard.userId, userId), eq(taskCard.enterpriseId, enterpriseId)));
    return Promise.all(rows.map((r) => this.loadWithItems(r)));
  }

  private async loadWithItems(row: typeof taskCard.$inferSelect): Promise<TaskCardT> {
    const items = await this.db
      .select()
      .from(taskItem)
      .where(and(eq(taskItem.userId, row.userId), eq(taskItem.enterpriseId, row.enterpriseId)));

    const toItem = (r: typeof taskItem.$inferSelect): TaskItem => ({
      ref: r.invoiceNo as never,
      state: r.state as TaskItem['state'],
      note: r.note,
      updatedAt: parseIsoDate(toDay(r.updatedAt)),
    });

    const snap: TaskCardSnapshot = {
      id: `${row.userId}:${row.enterpriseId}`,
      userId: row.userId,
      enterpriseId: row.enterpriseId,
      month: parseMonth(toDay(row.month).slice(0, 7)),
      status: row.status as TaskStatus,
      pending: items.filter((i) => i.state === 'pending').map(toItem),
      completed: items.filter((i) => i.state === 'done').map(toItem),
      note: row.note,
      revision: row.revision,
      openedAt: parseIsoDate(toDay(row.openedAt)),
      updatedAt: parseIsoDate(toDay(row.updatedAt)),
    };
    return TaskCard.rehydrate(snap);
  }
}

function toDay(v: string | Date): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
}
