/**
 * Harness 启动装配辅助（单一实现）。
 *
 * 此前 api/runtime-factory、worker/worker、cli/bootstrap 各写了一份
 * `createIds` / `makeRuleLoader` / `makeMemoryLoader` / `makePreferenceLoader`
 * （jscpd 报的 55 行克隆）。这里收敛到 runtime 包：
 * - 依赖仅 contracts（UnitOfWork 端口）与 domain，不依赖 adapters 具体实现；
 * - 用 contracts 的 `UnitOfWork` 而非 `SqliteUnitOfWork`，保持分层边界
 *   （depcruise `runtime-no-adapters`）。
 */
import type { RuleReference, UnitOfWork } from '@harness/contracts';
import { type EnterpriseId, type Month, selectApplicableRules, type UserId } from '@harness/domain';
import type { MemoryLine } from '../context/index.js';

/** 进程内递增 ID 生成器（runId / toolCallId 等）。 */
export function createIds(): { next: (p: string) => string } {
  let n = 0;
  return {
    next(p: string): string {
      n += 1;
      return `${p}_${n}`;
    },
  };
}

/** 召回本期适用规则，映射成 Harness 需要的 RuleReference 列表。 */
export function makeRuleLoader(uow: UnitOfWork) {
  return async (e: EnterpriseId, m: Month): Promise<readonly RuleReference[]> => {
    const candidates = await uow.run(async (tx) => tx.rules.listCandidates(e));
    const sel = selectApplicableRules({ candidates, scope: e, asOfMonth: m });
    return sel.selected.map((c) => ({
      code: c.code,
      version: c.version,
      title: c.title,
      scope: c.scopeLabel,
      effectiveFrom: c.effectiveFrom,
      status: 'enabled',
    }));
  };
}

/** 召回当前用户/企业的未完成任务卡（一条 MemoryLine）。 */
export function makeMemoryLoader(uow: UnitOfWork) {
  return async (u: UserId, e: EnterpriseId): Promise<MemoryLine | null> => {
    const card = await uow.run(async (tx) => tx.taskCards.findActive(u, e));
    if (card === null) return null;
    const s = card.toSnapshot();
    return {
      enterpriseName: String(e),
      month: s.month,
      pending: s.pending.map((p) => String(p.ref)),
      note: s.note,
    };
  };
}

/** 召回当前用户/企业的长期偏好。 */
export function makePreferenceLoader(uow: UnitOfWork) {
  return async (u: UserId, e: EnterpriseId): Promise<Array<{ key: string; value: string }>> => {
    const rows = await uow.run(async (tx) => tx.preferences.list(u, e));
    return rows.map((r) => {
      const s = r.toSnapshot();
      return { key: s.key, value: s.value };
    });
  };
}
