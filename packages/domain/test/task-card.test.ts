import { describe, expect, it } from 'vitest';
import type { InvoiceRef, WriteConfirmation } from '../src/index.js';
import {
  enterpriseId,
  InvoiceId,
  invoiceNo,
  invoiceRefParts,
  memoryScope,
  parseIsoDate,
  parseMonth,
  parseRequestId,
  refKey,
  TaskCard,
  TaskCardRevisionConflictError,
  TaskCardStateError,
  userId,
} from '../src/index.js';

const U001 = userId('U001');
const C001 = enterpriseId('C001');
const C002 = enterpriseId('C002');

const SCOPE = memoryScope(U001, C001);
const SEP = parseMonth('2026-09');

const D_2026_09_01 = parseIsoDate('2026-09-01');
const D_2026_09_02 = parseIsoDate('2026-09-02');
const D_2026_09_03 = parseIsoDate('2026-09-03');
const D_2026_09_04 = parseIsoDate('2026-09-04');

/** C001/2026-09 缺失用途的 5 张（GOLDEN_PURPOSE_GAPS.required）。 */
const GAPS: readonly InvoiceRef[] = ['F002', 'F003', 'F004', 'F006', 'F009'].map((no) =>
  invoiceRefParts(C001, invoiceNo(no)),
);

function open(): TaskCard {
  return TaskCard.open(SCOPE, SEP, GAPS, D_2026_09_01).card;
}

function confirmationOf(
  ref: InvoiceRef,
  overrides: Partial<WriteConfirmation> = {},
): WriteConfirmation {
  return {
    invoiceId: InvoiceId.of(ref.enterpriseId, ref.invoiceNo),
    field: 'purpose',
    requestId: parseRequestId('req-1'),
    verifiedAt: D_2026_09_02,
    observedVersion: 2,
    ...overrides,
  };
}

describe('TaskCard.open', () => {
  it('按引用建立待办，去重且 revision 从 0 起', () => {
    const { card, event } = TaskCard.open(
      SCOPE,
      SEP,
      [...GAPS, GAPS[0] as InvoiceRef],
      D_2026_09_01,
    );
    expect(card.pending).toHaveLength(5);
    expect(card.completed).toHaveLength(0);
    expect(card.revision).toBe(0);
    expect(card.status).toBe('active');
    expect(event.type).toBe('memory.task-card-opened');
    expect(event.pendingCount).toBe(5);
    expect(card.id.value).toBe('U001|C001|2026-09');
  });

  it('只存引用，不存金额/销售方/用途文本', () => {
    const card = open();
    const item = card.pending[0];
    expect(item).toBeDefined();
    if (item) {
      expect(Object.keys(item.ref).sort()).toEqual(['enterpriseId', 'invoiceNo']);
      expect(refKey(item.ref)).toBe('C001/F002');
      expect(item.state).toBe('pending');
    }
  });

  it('addPending 幂等：重复添加不改变 revision', () => {
    const card = open();
    const before = card.revision;
    card.addPending([GAPS[0] as InvoiceRef], D_2026_09_02);
    expect(card.revision).toBe(before);
    expect(card.pending).toHaveLength(5);
  });

  it('addPending 新增才会 touch，且不会把已完成的重新变回待办', () => {
    const card = open();
    card.markCompleted(GAPS[0] as InvoiceRef, confirmationOf(GAPS[0] as InvoiceRef), D_2026_09_02);
    const rev = card.revision;

    card.addPending([GAPS[0] as InvoiceRef], D_2026_09_03);
    expect(card.revision).toBe(rev);
    expect(card.completed).toHaveLength(1);

    card.addPending([invoiceRefParts(C001, invoiceNo('F010'))], D_2026_09_03);
    expect(card.revision).toBe(rev + 1);
    expect(card.pending).toHaveLength(5); // 4 原有 + 1 新增
  });
});

describe('TaskCard.markCompleted', () => {
  it('写入确认匹配时从 pending 移到 completed，并带上 requestId', () => {
    const card = open();
    const ref = GAPS[0] as InvoiceRef;
    const event = card.markCompleted(ref, confirmationOf(ref), D_2026_09_02);

    expect(card.pending).toHaveLength(4);
    expect(card.completed).toHaveLength(1);
    expect(card.completed[0]?.state).toBe('done');
    expect(event.type).toBe('memory.task-item-completed');
    expect(event.requestId).toBe('req-1');
    expect(card.revision).toBe(1);
  });

  it('写入确认指向另一张发票 → TaskCardStateError（不允许未复核的完成）', () => {
    const card = open();
    const ref = GAPS[0] as InvoiceRef;
    const wrong = confirmationOf(invoiceRefParts(C001, invoiceNo('F010')));
    expect(() => card.markCompleted(ref, wrong, D_2026_09_02)).toThrow(TaskCardStateError);
    expect(card.pending).toHaveLength(5);
  });

  it('写入确认指向另一企业 → TaskCardStateError', () => {
    const card = open();
    const ref = GAPS[0] as InvoiceRef;
    const crossEnterprise = {
      ...confirmationOf(ref),
      invoiceId: InvoiceId.of(C002, ref.invoiceNo),
    };
    expect(() => card.markCompleted(ref, crossEnterprise, D_2026_09_02)).toThrow(
      TaskCardStateError,
    );
  });

  it('不在待办中的发票不能标记完成', () => {
    const card = open();
    const stray = invoiceRefParts(C001, invoiceNo('F010'));
    expect(() => card.markCompleted(stray, confirmationOf(stray), D_2026_09_02)).toThrow(
      TaskCardStateError,
    );
  });

  it('非 purpose/remark 的字段被拒绝', () => {
    const card = open();
    const ref = GAPS[0] as InvoiceRef;
    const bad = { ...confirmationOf(ref), field: 'amount' as never };
    expect(() => card.markCompleted(ref, bad, D_2026_09_02)).toThrow(TaskCardStateError);
  });
});

describe('TaskCard.complete / abandon', () => {
  it('仍有待办时 complete 抛错', () => {
    const card = open();
    const ref = GAPS[0] as InvoiceRef;
    card.markCompleted(ref, confirmationOf(ref), D_2026_09_02);
    expect(() => card.complete(D_2026_09_03)).toThrow(TaskCardStateError);
  });

  it('待办清空且至少完成一项 → complete 成功并结卡', () => {
    const card = open();
    for (const ref of GAPS) {
      card.markCompleted(ref, confirmationOf(ref), D_2026_09_02);
    }
    expect(card.isComplete()).toBe(true);
    const event = card.complete(D_2026_09_03);
    expect(event.type).toBe('memory.task-card-completed');
    expect(event.doneCount).toBe(5);
    expect(card.status).toBe('completed');
  });

  it('零完成项的卡不能 complete（应走 abandon）', () => {
    const card = TaskCard.open(SCOPE, SEP, [], D_2026_09_01).card;
    expect(() => card.complete(D_2026_09_02)).toThrow(TaskCardStateError);
    expect(card.abandon('本月无缺失', D_2026_09_02).type).toBe('memory.task-card-abandoned');
    expect(card.status).toBe('abandoned');
  });

  it('结卡后任何变更都被拒绝', () => {
    const card = open();
    for (const ref of GAPS) {
      card.markCompleted(ref, confirmationOf(ref), D_2026_09_02);
    }
    card.complete(D_2026_09_03);
    expect(() => card.addPending([invoiceRefParts(C001, invoiceNo('F010'))], D_2026_09_04)).toThrow(
      TaskCardStateError,
    );
    expect(() => card.complete(D_2026_09_04)).toThrow(TaskCardStateError);
  });
});

describe('TaskCard 乐观锁与进度', () => {
  it('revision 不符 → TaskCardRevisionConflictError', () => {
    const card = open();
    card.addPending([invoiceRefParts(C001, invoiceNo('F010'))], D_2026_09_02);
    expect(() => card.assertRevision(0)).toThrow(TaskCardRevisionConflictError);
    expect(() => card.assertRevision(card.revision)).not.toThrow();
  });

  it('progress 汇总 total/done/pending', () => {
    const card = open();
    const ref = GAPS[0] as InvoiceRef;
    card.markCompleted(ref, confirmationOf(ref), D_2026_09_02);
    expect(card.progress()).toEqual({ total: 5, done: 1, pending: 4 });
  });

  it('setNote 去重且空串归一化为 null', () => {
    const card = open();
    const rev = card.revision;
    card.setNote('   ', D_2026_09_02);
    expect(card.note).toBeNull();
    expect(card.revision).toBe(rev);

    card.setNote('  月底集中补录  ', D_2026_09_02);
    expect(card.note).toBe('月底集中补录');
    expect(card.revision).toBe(rev + 1);
  });
});

describe('TaskCard.reconcile', () => {
  it('移除已不再缺失的待办、补入新缺失项，并保留已完成项', () => {
    const card = open();
    const done = GAPS[0] as InvoiceRef;
    card.markCompleted(done, confirmationOf(done), D_2026_09_02);

    // 现状：F002 已完成，其余 4 张待办
    // 重新检查后：只剩 F003/F004 仍缺失，另新增 F010
    const stillMissing = [
      invoiceRefParts(C001, invoiceNo('F003')),
      invoiceRefParts(C001, invoiceNo('F004')),
      invoiceRefParts(C001, invoiceNo('F010')),
    ];
    const event = card.reconcile(stillMissing, D_2026_09_03);

    expect(event.type).toBe('memory.task-reconciled');
    expect(event.removed.map(refKey).sort()).toEqual(['C001/F006', 'C001/F009']);
    expect(event.added.map(refKey)).toEqual(['C001/F010']);
    expect(event.remaining).toBe(3);
    // 已完成项不因重新检查被清掉
    expect(card.completed.map((i) => refKey(i.ref))).toEqual(['C001/F002']);
    expect(card.pending.map((i) => refKey(i.ref)).sort()).toEqual([
      'C001/F003',
      'C001/F004',
      'C001/F010',
    ]);
  });

  it('无差异时 reconcile 不改变 revision', () => {
    const card = open();
    const rev = card.revision;
    const event = card.reconcile(GAPS, D_2026_09_03);
    expect(event.added).toEqual([]);
    expect(event.removed).toEqual([]);
    expect(event.remaining).toBe(5);
    expect(card.revision).toBe(rev);
  });
});

describe('TaskCard 快照', () => {
  it('rehydrate 保留状态与 revision', () => {
    const card = open();
    const ref = GAPS[0] as InvoiceRef;
    card.markCompleted(ref, confirmationOf(ref), D_2026_09_02);
    card.setNote('备注', D_2026_09_02);

    const restored = TaskCard.rehydrate(card.toSnapshot());
    expect(restored.revision).toBe(card.revision);
    expect(restored.pending).toHaveLength(4);
    expect(restored.completed).toHaveLength(1);
    expect(restored.note).toBe('备注');
    expect(restored.id.value).toBe('U001|C001|2026-09');
  });
});
