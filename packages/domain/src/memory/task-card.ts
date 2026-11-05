import {
  InvalidTextError,
  TaskCardRevisionConflictError,
  TaskCardStateError,
} from '../shared/domain-error.js';
import type { RequestId } from '../shared/domain-event.js';
import type { InvoiceId } from '../shared/ids.js';
import type { IsoDate, Month } from '../shared/month.js';
import type { InvoiceRef, MemoryScope } from './memory-scope.js';
import { refKey, scopeKey } from './memory-scope.js';

export type TaskStatus = 'active' | 'completed' | 'abandoned';
export type TaskItemState = 'pending' | 'done' | 'skipped';

/** `${scopeKey}|${month}` */
export interface TaskCardId {
  readonly value: string;
}

export function taskCardId(scope: MemoryScope, month: Month): TaskCardId {
  return Object.freeze({ value: `${scopeKey(scope)}|${month}` });
}

export interface TaskItem {
  readonly ref: InvoiceRef;
  readonly state: TaskItemState;
  readonly note: string | null;
  readonly updatedAt: IsoDate;
}

/** 已复核的写入确认：没有它不允许把待办标记为完成。 */
export interface WriteConfirmation {
  readonly invoiceId: InvoiceId;
  readonly field: 'purpose' | 'remark';
  readonly requestId: RequestId;
  readonly verifiedAt: IsoDate;
  readonly observedVersion: number;
}

export interface TaskCardSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly enterpriseId: string;
  readonly month: Month;
  readonly status: TaskStatus;
  readonly pending: readonly TaskItem[];
  readonly completed: readonly TaskItem[];
  readonly note: string | null;
  readonly revision: number;
  readonly openedAt: IsoDate;
  readonly updatedAt: IsoDate;
}

/* ------------------------------- 事件 ------------------------------- */

export interface TaskCardOpened {
  readonly type: 'memory.task-card-opened';
  readonly taskCardId: TaskCardId;
  readonly scope: MemoryScope;
  readonly month: Month;
  readonly pendingCount: number;
  readonly occurredAt: IsoDate;
}

export interface TaskItemCompleted {
  readonly type: 'memory.task-item-completed';
  readonly taskCardId: TaskCardId;
  readonly scope: MemoryScope;
  readonly ref: InvoiceRef;
  readonly requestId: RequestId;
  readonly occurredAt: IsoDate;
}

export interface TaskCardCompleted {
  readonly type: 'memory.task-card-completed';
  readonly taskCardId: TaskCardId;
  readonly scope: MemoryScope;
  readonly month: Month;
  readonly doneCount: number;
  readonly occurredAt: IsoDate;
}

export interface TaskCardAbandoned {
  readonly type: 'memory.task-card-abandoned';
  readonly taskCardId: TaskCardId;
  readonly reason: string;
  readonly occurredAt: IsoDate;
}

export interface TaskReconciled {
  readonly type: 'memory.task-reconciled';
  readonly taskCardId: TaskCardId;
  readonly added: readonly InvoiceRef[];
  readonly removed: readonly InvoiceRef[];
  readonly remaining: number;
  readonly occurredAt: IsoDate;
}

/**
 * 任务卡：跨轮次的「本月还差哪些发票没补用途」。
 *
 * 关键约束：
 * - 只存 `InvoiceRef`，不存金额/销售方/用途快照 —— 展示时回 Ledger 取当前值，
 *   否则用户改了用途之后卡上还是旧文本。
 * - `pending` 与 `completed` 不相交，同一张发票只能处于一种状态。
 * - `completed` 当且仅当 `pending` 为空且至少有一项完成。
 * - 每次状态变更 `revision` +1，写入时用 `expectedRevision` 校验（乐观锁）。
 */
export class TaskCard {
  private constructor(
    readonly id: TaskCardId,
    readonly scope: MemoryScope,
    readonly month: Month,
    private pendingItems: TaskItem[],
    private completedItems: TaskItem[],
    private stateValue: TaskStatus,
    private noteValue: string | null,
    private revisionValue: number,
    readonly openedAt: IsoDate,
    private updatedAtValue: IsoDate,
  ) {}

  static open(
    scope: MemoryScope,
    month: Month,
    refs: readonly InvoiceRef[],
    at: IsoDate,
  ): { card: TaskCard; event: TaskCardOpened } {
    const unique = new Map<string, TaskItem>();
    for (const ref of refs) {
      unique.set(refKey(ref), { ref, state: 'pending', note: null, updatedAt: at });
    }
    const card = new TaskCard(
      taskCardId(scope, month),
      scope,
      month,
      [...unique.values()],
      [],
      'active',
      null,
      0,
      at,
      at,
    );
    return {
      card,
      event: {
        type: 'memory.task-card-opened',
        taskCardId: card.id,
        scope,
        month,
        pendingCount: card.pendingItems.length,
        occurredAt: at,
      },
    };
  }

  static rehydrate(s: TaskCardSnapshot): TaskCard {
    return new TaskCard(
      { value: s.id },
      { userId: s.userId, enterpriseId: s.enterpriseId } as MemoryScope,
      s.month,
      [...s.pending],
      [...s.completed],
      s.status,
      s.note,
      s.revision,
      s.openedAt,
      s.updatedAt,
    );
  }

  get status(): TaskStatus {
    return this.stateValue;
  }

  get note(): string | null {
    return this.noteValue;
  }

  get revision(): number {
    return this.revisionValue;
  }

  get updatedAt(): IsoDate {
    return this.updatedAtValue;
  }

  get pending(): readonly TaskItem[] {
    return [...this.pendingItems];
  }

  get completed(): readonly TaskItem[] {
    return [...this.completedItems];
  }

  /** 幂等：重复添加同一张发票直接忽略，不算一次状态变更。 */
  addPending(refs: readonly InvoiceRef[], at: IsoDate): void {
    this.assertActive('添加待办');
    let changed = false;
    for (const ref of refs) {
      const key = refKey(ref);
      if (this.pendingItems.some((i) => refKey(i.ref) === key)) continue;
      if (this.completedItems.some((i) => refKey(i.ref) === key)) continue;
      this.pendingItems.push({ ref, state: 'pending', note: null, updatedAt: at });
      changed = true;
    }
    if (changed) this.touch(at);
  }

  /**
   * 标记完成。必须携带**已复核**的写入确认：
   * `confirmation.invoiceId` 与本项必须是同一企业同一编号，
   * 且 `field` 只能是 purpose/remark。未复核的写入不得标记完成。
   */
  markCompleted(ref: InvoiceRef, evidence: WriteConfirmation, at: IsoDate): TaskItemCompleted {
    this.assertActive('标记完成');

    const key = refKey(ref);
    const idx = this.pendingItems.findIndex((i) => refKey(i.ref) === key);
    if (idx < 0) {
      throw new TaskCardStateError('该发票不在待办列表中，不能标记完成', { ref: key });
    }
    if (
      evidence.invoiceId.enterpriseId !== ref.enterpriseId ||
      evidence.invoiceId.invoiceNo !== ref.invoiceNo
    ) {
      throw new TaskCardStateError('写入确认与待办项不是同一张发票', {
        ref: key,
        confirmed: evidence.invoiceId.value(),
      });
    }
    if (evidence.field !== 'purpose' && evidence.field !== 'remark') {
      throw new TaskCardStateError('写入确认的字段只能是 purpose 或 remark', {
        field: String(evidence.field),
      });
    }

    const [item] = this.pendingItems.splice(idx, 1);
    if (item !== undefined) {
      this.completedItems.push({ ...item, state: 'done', updatedAt: at });
    }
    this.touch(at);

    return {
      type: 'memory.task-item-completed',
      taskCardId: this.id,
      scope: this.scope,
      ref,
      requestId: evidence.requestId,
      occurredAt: at,
    };
  }

  /** 更新备注。`null` 表示清空；长度上限 500。 */
  setNote(note: string | null, at: IsoDate): void {
    this.assertActive('修改备注');
    const next = note === null ? null : note.trim();
    if (next !== null && next.length > 500) {
      throw new InvalidTextError('任务卡备注不能超过 500 字', { length: next.length });
    }
    const normalized = next === '' ? null : next;
    if (normalized === this.noteValue) return;
    this.noteValue = normalized;
    this.touch(at);
  }

  /**
   * 结卡。仅当 `pending` 为空且至少完成一项时成立 ——
   * 全部 skipped 的卡不能自动完成，必须显式 `abandon`。
   */
  complete(at: IsoDate): TaskCardCompleted {
    this.assertActive('完成');
    if (this.pendingItems.length > 0) {
      throw new TaskCardStateError('仍有待办发票未处理，不能完成', {
        taskCardId: this.id.value,
        pending: this.pendingItems.length,
      });
    }
    if (this.completedItems.length === 0) {
      throw new TaskCardStateError('没有任何已完成项，不能标记完成（请改用放弃）', {
        taskCardId: this.id.value,
      });
    }
    this.stateValue = 'completed';
    this.touch(at);
    return {
      type: 'memory.task-card-completed',
      taskCardId: this.id,
      scope: this.scope,
      month: this.month,
      doneCount: this.completedItems.length,
      occurredAt: at,
    };
  }

  abandon(reason: string, at: IsoDate): TaskCardAbandoned {
    this.assertActive('放弃');
    if (reason.trim().length === 0) {
      throw new InvalidTextError('放弃任务卡必须给出原因', { taskCardId: this.id.value });
    }
    this.stateValue = 'abandoned';
    this.touch(at);
    return {
      type: 'memory.task-card-abandoned',
      taskCardId: this.id,
      reason,
      occurredAt: at,
    };
  }

  /**
   * 重新检查后刷新待办：
   * - 仍在缺失集合中的保留（含已完成项，不因重新检查被清掉）；
   * - 已不在缺失集合中的 pending 项移除，并记为 added/removed 供审计。
   */
  reconcile(missingNow: readonly InvoiceRef[], at: IsoDate): TaskReconciled {
    this.assertActive('对账');
    const wanted = new Set(missingNow.map(refKey));

    const removed = this.pendingItems.filter((i) => !wanted.has(refKey(i.ref)));
    this.pendingItems = this.pendingItems.filter((i) => wanted.has(refKey(i.ref)));

    const existing = new Set([
      ...this.pendingItems.map((i) => refKey(i.ref)),
      ...this.completedItems.map((i) => refKey(i.ref)),
    ]);
    const added: InvoiceRef[] = [];
    for (const ref of missingNow) {
      const key = refKey(ref);
      if (existing.has(key)) continue;
      this.pendingItems.push({ ref, state: 'pending', note: null, updatedAt: at });
      added.push(ref);
      existing.add(key);
    }

    if (added.length > 0 || removed.length > 0) this.touch(at);

    return {
      type: 'memory.task-reconciled',
      taskCardId: this.id,
      added,
      removed: removed.map((i) => i.ref),
      remaining: this.pendingItems.length,
      occurredAt: at,
    };
  }

  isComplete(): boolean {
    return this.pendingItems.length === 0 && this.completedItems.length > 0;
  }

  progress(): { readonly total: number; readonly done: number; readonly pending: number } {
    return {
      total: this.pendingItems.length + this.completedItems.length,
      done: this.completedItems.length,
      pending: this.pendingItems.length,
    };
  }

  /** 乐观锁校验：调用方预期版本与实际不符即冲突。 */
  assertRevision(expected: number): void {
    if (expected !== this.revisionValue) {
      throw new TaskCardRevisionConflictError('任务卡已被其他操作修改，请刷新后重试', {
        taskCardId: this.id.value,
        expected,
        actual: this.revisionValue,
      });
    }
  }

  toSnapshot(): TaskCardSnapshot {
    return {
      id: this.id.value,
      userId: this.scope.userId,
      enterpriseId: this.scope.enterpriseId,
      month: this.month,
      status: this.stateValue,
      pending: this.pending,
      completed: this.completed,
      note: this.noteValue,
      revision: this.revisionValue,
      openedAt: this.openedAt,
      updatedAt: this.updatedAtValue,
    };
  }

  private assertActive(action: string): void {
    if (this.stateValue !== 'active') {
      throw new TaskCardStateError(
        `任务卡已${this.stateValue === 'completed' ? '完成' : '放弃'}，不能${action}`,
        {
          taskCardId: this.id.value,
          status: this.stateValue,
        },
      );
    }
  }

  private touch(at: IsoDate): void {
    this.revisionValue += 1;
    this.updatedAtValue = at;
  }
}
