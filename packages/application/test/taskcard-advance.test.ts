import {
  enterpriseId,
  InvoiceId as ID,
  invoiceRef,
  memoryScope,
  parseIsoDate,
  parseMonth,
  refKey,
  TaskCard,
  userId,
} from '@harness/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Deps } from '../src/deps.js';
import { setInvoicePurpose } from '../src/use-cases/command/set-invoice-purpose.js';
import { findPurposeGaps } from '../src/use-cases/query/find-purpose-gaps.js';
import { FakeClock, type InMemoryUnitOfWork, SequentialIdGenerator } from './fakes/in-memory.js';
import { makeWorld } from './fixtures.js';

const U1 = userId('U001');
const C1 = enterpriseId('C001');
const C2 = enterpriseId('C002');

let uow: InMemoryUnitOfWork;
let deps: Deps;
let clock: FakeClock;
let runSeq = 0;

function cmd(over: Partial<Parameters<typeof setInvoicePurpose>[1]> = {}) {
  runSeq += 1;
  return {
    actor: U1,
    enterpriseId: C1,
    invoiceNo: 'F002',
    newPurpose: '办公用品采购',
    runId: `run_${runSeq}`,
    toolCallId: `call_${runSeq}`,
    ...over,
  };
}

beforeEach(() => {
  const w = makeWorld();
  uow = w.uow;
  clock = new FakeClock();
  deps = { uow, clock, ids: new SequentialIdGenerator() };
});

describe('P0 · TaskCard 自动推进', () => {
  it('发票在待办中 → 保存成功后自动迁移到 completed', async () => {
    // 建任务卡：C001 9 月，待办含 F002
    const scope = memoryScope(U1, C1);
    const { card } = TaskCard.open(
      scope,
      parseMonth('2026-09'),
      [invoiceRef(ID.of('C001', 'F002'))],
      parseIsoDate('2026-09-01'),
    );
    await uow.run((tx) => tx.taskCards.save(card, 0));

    // 确认 F002 在待办
    const before = await uow.run((tx) => tx.taskCards.findActive(U1, C1));
    expect(before?.toSnapshot().pending.map((p) => refKey(p.ref))).toContain('C001/F002');

    // 执行写用途
    const r = await setInvoicePurpose(deps, cmd());
    expect(r.kind).toBe('saved');

    // 确认自动迁移
    const after = await uow.run((tx) => tx.taskCards.findActive(U1, C1));
    const snap = after?.toSnapshot();
    expect(snap?.pending.map((p) => refKey(p.ref))).not.toContain('C001/F002');
    expect(snap?.completed.map((p) => refKey(p.ref))).toContain('C001/F002');
  });

  it('发票不在待办中 → 静默跳过，不报错', async () => {
    const scope = memoryScope(U1, C1);
    const { card } = TaskCard.open(
      scope,
      parseMonth('2026-09'),
      [invoiceRef(ID.of('C001', 'F003'))], // 只包含 F003
      parseIsoDate('2026-09-01'),
    );
    await uow.run((tx) => tx.taskCards.save(card, 0));

    // 写 F002（不在待办）
    const r = await setInvoicePurpose(deps, cmd({ invoiceNo: 'F002' }));
    expect(r.kind).toBe('saved');

    // 任务卡不变
    const after = await uow.run((tx) => tx.taskCards.findActive(U1, C1));
    const snap = after?.toSnapshot();
    expect(snap?.pending.map((p) => refKey(p.ref))).toEqual(['C001/F003']);
    expect(snap?.completed).toEqual([]);
  });

  it('无任务卡 → 写入正常，不尝试建卡', async () => {
    const r = await setInvoicePurpose(deps, cmd());
    expect(r.kind).toBe('saved');

    const card = await uow.run((tx) => tx.taskCards.findActive(U1, C1));
    expect(card).toBeNull();
  });

  it('任务卡被改动（乐观锁冲突）→ 写入仍成功，任务卡不推进', async () => {
    const scope = memoryScope(U1, C1);
    const { card } = TaskCard.open(
      scope,
      parseMonth('2026-09'),
      [invoiceRef(ID.of('C001', 'F002'))],
      parseIsoDate('2026-09-01'),
    );
    await uow.run((tx) => tx.taskCards.save(card, 0));

    // 模拟另一个进程改动了任务卡
    await uow.run(async (tx) => {
      const stale = await tx.taskCards.findActive(U1, C1);
      if (stale) {
        stale.setNote('外部更新', parseIsoDate('2026-09-02'));
        await tx.taskCards.save(stale, stale.revision - 1);
      }
    });

    const r = await setInvoicePurpose(deps, cmd());
    expect(r.kind).toBe('saved');

    // 写库成功，任务卡不被覆盖（乐观锁防住了）
    const after = await uow.run((tx) => tx.taskCards.findActive(U1, C1));
    expect(after?.toSnapshot().note).toBe('外部更新');
  });
});

describe('P0 · 多轮补充全链路', () => {
  it('检查→补一张→任务卡 pending 自动减少', async () => {
    // 检查 C002/09 缺项
    const gaps = await findPurposeGaps(deps, {
      actor: U1,
      enterpriseId: C2,
      month: parseMonth('2026-09'),
    });
    expect(gaps.kind).toBe('ok');
    if (gaps.kind !== 'ok') return;

    const gapNos = gaps.gaps.map((g) => g.invoiceNo);
    expect(gapNos.sort()).toEqual(['F002', 'F005', 'F006']);

    // 据此建任务卡
    const scope = memoryScope(U1, C2);
    const { card } = TaskCard.open(
      scope,
      parseMonth('2026-09'),
      gapNos.map((no) => invoiceRef(ID.of('C002', no))),
      parseIsoDate('2026-09-01'),
    );
    await uow.run((tx) => tx.taskCards.save(card, 0));

    // 补第一张
    const r = await setInvoicePurpose(
      deps,
      cmd({
        enterpriseId: C2,
        invoiceNo: 'F002',
        newPurpose: '宣传资料印刷',
        runId: 'r1',
        toolCallId: 'c1',
      }),
    );
    expect(r.kind).toBe('saved');

    // 任务卡自动更新
    const after = await uow.run((tx) => tx.taskCards.findActive(U1, C2));
    const snap = after?.toSnapshot();
    expect(snap?.pending.map((p) => refKey(p.ref)).sort()).toEqual(['C002/F005', 'C002/F006']);
    expect(snap?.completed.map((p) => refKey(p.ref))).toEqual(['C002/F002']);
  });
});
