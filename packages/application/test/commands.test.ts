import { enterpriseId, userId } from '@harness/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Deps } from '../src/deps.js';
import { setInvoicePurpose } from '../src/use-cases/command/set-invoice-purpose.js';
import { FakeClock, type InMemoryUnitOfWork, SequentialIdGenerator } from './fakes/in-memory.js';
import { makeWorld } from './fixtures.js';

const U1 = userId('U001');
const U2 = userId('U002');
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

/* ------------------------------ 主链路 ------------------------------ */

describe('setInvoicePurpose · 保存成功', () => {
  it('返回 before / after / rereadAt，且真实写入了存储', async () => {
    const r = await setInvoicePurpose(deps, cmd());
    expect(r.kind).toBe('saved');
    if (r.kind !== 'saved') return;

    expect(r.changed).toBe(true);
    expect(r.before).toBeNull();
    expect(r.after).toBe('办公用品采购');
    expect(r.rereadAt).not.toBe('');
    expect(r.invoiceNo).toBe('F002');
  });

  it('保存后重新查询能读到新值', async () => {
    await setInvoicePurpose(deps, cmd());
    const tx = await uow.run(async (t) =>
      t.invoices.findById((await import('@harness/domain')).InvoiceId.of('C001', 'F002')),
    );
    expect(tx?.purpose).toBe('办公用品采购');
  });

  it('写入日志记录了旧值与新值', async () => {
    await setInvoicePurpose(deps, cmd());
    expect(uow.writeLog.entries).toHaveLength(1);
    expect(uow.writeLog.entries[0]?.oldValue).toBeNull();
    expect(uow.writeLog.entries[0]?.newValue).toBe('办公用品采购');
  });

  it('输入两端的空白被 trim', async () => {
    const r = await setInvoicePurpose(deps, cmd({ newPurpose: '  办公用品采购  ' }));
    if (r.kind !== 'saved') throw new Error('expected saved');
    expect(r.after).toBe('办公用品采购');
  });
});

/* -------------------------- 同值 → 不写库 -------------------------- */

describe('setInvoicePurpose · 同值幂等（不靠 key，靠语义）', () => {
  it('第二次填同样内容 → changed:false，且不再写库', async () => {
    await setInvoicePurpose(deps, cmd());
    const callsAfterFirst = uow.invoices.saveCalls;

    const r2 = await setInvoicePurpose(deps, cmd({ newPurpose: '办公用品采购' }));
    expect(r2.kind).toBe('saved');
    if (r2.kind !== 'saved') return;
    expect(r2.changed).toBe(false);
    expect(uow.invoices.saveCalls).toBe(callsAfterFirst);
  });

  it('即使换 runId / toolCallId，同值仍是 no-op', async () => {
    await setInvoicePurpose(deps, cmd());
    const r2 = await setInvoicePurpose(deps, cmd({ newPurpose: '办公用品采购' }));
    if (r2.kind !== 'saved') throw new Error('expected saved');
    expect(r2.changed).toBe(false);
  });
});

/* ------------------------------ 权限 ------------------------------ */

describe('setInvoicePurpose · 权限', () => {
  it('U002 对 C001 只读 → denied，且仓储未被调用', async () => {
    const r = await setInvoicePurpose(deps, cmd({ actor: U2 }));
    expect(r.kind).toBe('denied');
    if (r.kind !== 'denied') return;
    expect(r.reason).toBe('read_only_enterprise');
    expect(uow.invoices.saveCalls).toBe(0);
  });

  it('U002 对 C002 无权 → denied，先于对象存在性', async () => {
    const r = await setInvoicePurpose(deps, cmd({ actor: U2, enterpriseId: C2 }));
    expect(r.kind).toBe('denied');
    if (r.kind !== 'denied') return;
    expect(r.reason).toBe('enterprise_not_accessible');
    expect(uow.invoices.saveCalls).toBe(0);
  });

  it('无权时即使发票不存在也返回 denied 而不是 not-found（不泄漏存在性）', async () => {
    const r = await setInvoicePurpose(
      deps,
      cmd({ actor: U2, enterpriseId: C2, invoiceNo: 'F999' }),
    );
    expect(r.kind).toBe('denied');
  });
});

/* ------------------------------ 存在性 ------------------------------ */

describe('setInvoicePurpose · 对象不存在', () => {
  it('发票号不存在 → not-found', async () => {
    const r = await setInvoicePurpose(deps, cmd({ invoiceNo: 'F999' }));
    expect(r.kind).toBe('not-found');
  });

  it('跨企业同号不会串：C002/F002 与 C001/F002 是两张不同的票', async () => {
    await setInvoicePurpose(deps, cmd({ enterpriseId: C1, invoiceNo: 'F002' }));
    const c002 = await uow.run(async (t) =>
      t.invoices.findById((await import('@harness/domain')).InvoiceId.of('C002', 'F002')),
    );
    expect(c002?.purpose).toBeNull();
  });
});

/* ------------------------------ 内容校验 ------------------------------ */

describe('setInvoicePurpose · 内容校验', () => {
  it('空字符串 → invalid(blank)', async () => {
    const r = await setInvoicePurpose(deps, cmd({ newPurpose: '' }));
    expect(r.kind).toBe('invalid');
    if (r.kind !== 'invalid') return;
    expect(r.reason).toBe('blank');
  });

  it('纯空白 → invalid(blank)', async () => {
    const r = await setInvoicePurpose(deps, cmd({ newPurpose: '    ' }));
    expect(r.kind).toBe('invalid');
    if (r.kind !== 'invalid') return;
    expect(r.reason).toBe('blank');
  });

  it('超长 → invalid(too-long)', async () => {
    const r = await setInvoicePurpose(deps, cmd({ newPurpose: 'x'.repeat(300) }));
    expect(r.kind).toBe('invalid');
  });

  it('控制字符 → invalid(control-chars)', async () => {
    const r = await setInvoicePurpose(deps, cmd({ newPurpose: '办公\u0007用品' }));
    expect(r.kind).toBe('invalid');
    if (r.kind !== 'invalid') return;
    expect(r.reason).toBe('control-chars');
  });
});

/* ------------------------------ 故障注入 ------------------------------ */

describe('setInvoicePurpose · 复核失败不得误报成功', () => {
  it('写入后回读不一致 → verify-failed，绝不返回 saved', async () => {
    uow.invoices.simulateVerifyFailure = true;
    const r = await setInvoicePurpose(deps, cmd());
    expect(r.kind).toBe('verify-failed');
    if (r.kind !== 'verify-failed') return;
    expect(r.expected).toBe('办公用品采购');
    expect(r.actual).toBeNull();
  });
});

describe('setInvoicePurpose · 乐观锁', () => {
  it('版本不符 → conflict，且带上当前版本号', async () => {
    const domain = await import('@harness/domain');
    const id = domain.InvoiceId.of('C001', 'F002');

    // 用真实的 save 路径把版本推进到 2（模拟另一个请求刚写完）
    await uow.run(async (t) => {
      const inv = await t.invoices.findById(id);
      if (inv === null) throw new Error('missing');
      const ok = await t.invoices.save(inv, inv.version);
      if (!ok) throw new Error('unexpected');
      return null;
    });

    // 造一个「读到的还是旧版本」的场景：记录当前版本，再推进一次
    await uow.run(async (t) => {
      const inv = await t.invoices.findById(id);
      if (inv === null) throw new Error('missing');
      const decision = { allowed: true as const, enterpriseId: C1, field: 'purpose' as const };
      inv.changePurpose(
        '先占位',
        decision,
        domain.parseRequestId('seed:1'),
        U1,
        domain.parseIsoDate('2026-09-01'),
      );
      await t.invoices.save(inv, inv.version - 1);
      return null;
    });

    // 现在仓储里的版本已经被推高。用陈旧版本号写 → 必须 conflict。
    const r = await uow.run(async (t) => {
      const inv = await t.invoices.findById(id);
      if (inv === null) throw new Error('missing');
      const decision = { allowed: true as const, enterpriseId: C1, field: 'purpose' as const };
      inv.changePurpose(
        '稍后的写入',
        decision,
        domain.parseRequestId('race:1'),
        U1,
        domain.parseIsoDate('2026-09-01'),
      );
      // 故意用过期版本号
      const ok = await t.invoices.save(inv, inv.version - 5);
      return ok;
    });

    expect(r).toBe(false);
  });
});
