/**
 * 共享应用层门面：explainRules 的 denied 分支不得被强转抹掉。
 * 回归 P0 遗留风险（此前 3 份 facade 用 `as unknown as` 把
 * `ExplainRulesOutcome` 窄化成不含 denied 的 `ExplainRulesResult`）。
 */
import { enterpriseId, parseMonth, userId } from '@harness/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Deps } from '../src/deps.js';
import { createApplicationFacade } from '../src/facade.js';
import { FakeClock, type InMemoryUnitOfWork, SequentialIdGenerator } from './fakes/in-memory.js';
import { makeWorld } from './fixtures.js';

const U2 = userId('U002');
const C2 = enterpriseId('C002'); // U2 对 C2 无权访问（权限矩阵：none）
const SEP = parseMonth('2026-09');

/** getTaskCard 不参与本测试，给一个最小同步桩即可。 */
const stubDb = { prepare: () => ({ get: () => undefined }) };

let uow: InMemoryUnitOfWork;
let deps: Deps;

beforeEach(() => {
  const w = makeWorld();
  uow = w.uow;
  deps = { uow, clock: new FakeClock(), ids: new SequentialIdGenerator() };
});

describe('createApplicationFacade · explainRules', () => {
  it('无权访问时原样返回 denied（kind=denied，含 reason/message），不伪装成 ok', async () => {
    const facade = createApplicationFacade(deps, stubDb);
    const r = await facade.explainRules({ actor: U2, enterpriseId: C2, month: SEP });
    expect(r.kind).toBe('denied');
    if (r.kind === 'denied') {
      expect(r.reason).toBe('enterprise_not_accessible');
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it('有权访问时返回 ok，携带 applied / excluded / rationale', async () => {
    const facade = createApplicationFacade(deps, stubDb);
    const r = await facade.explainRules({
      actor: userId('U001'),
      enterpriseId: enterpriseId('C001'),
      month: SEP,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(Array.isArray(r.applied)).toBe(true);
      expect(Array.isArray(r.excluded)).toBe(true);
      expect(r.rationale.length).toBeGreaterThan(0);
    }
  });
});
