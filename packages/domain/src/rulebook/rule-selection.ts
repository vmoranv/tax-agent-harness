import type { EnterpriseId } from '../shared/ids.js';
import type { IsoDate, Month } from '../shared/month.js';
import type { RuleCitation } from './rule-document.js';

export type { RuleCitation } from './rule-document.js';
export { formatCitation } from './rule-document.js';

/**
 * 候选被淘汰的原因。五个值缺一不可：
 * 前四个回答「为什么这条规则没被选中」，最后一个回答
 * 「这条规则本身没问题，但本轮不需要这一类」。
 */
export type RuleRejectionReason =
  | 'disabled'
  | 'other-enterprise'
  | 'not-yet-effective'
  | 'superseded'
  | 'category-not-needed';

/** 一条被淘汰的候选，`detail` 面向人解释，可直接进回复。 */
export interface RuleRejection {
  readonly code: string;
  readonly version: string;
  readonly reason: RuleRejectionReason;
  readonly detail: string;
}

/** 规则选择的结论：选了什么 + 为什么没选别的。 */
export interface RuleSelection {
  readonly enterpriseId: EnterpriseId;
  readonly asOfMonth: Month;
  readonly selected: readonly RuleCitation[];
  readonly rejected: readonly RuleRejection[];
  readonly resolvedAt: IsoDate;
  readonly algorithmVersion: 'triple-filter-v1';
}

/** 空选择：仍带上企业与月份，便于审计「查了但一条都没有」。 */
export function emptySelection(e: EnterpriseId, m: Month, at: IsoDate): RuleSelection {
  return {
    enterpriseId: e,
    asOfMonth: m,
    selected: [],
    rejected: [],
    resolvedAt: at,
    algorithmVersion: 'triple-filter-v1',
  };
}

/**
 * 指纹：对「选中集合」与「淘汰原因」一起做稳定摘要。
 *
 * 同一输入必须得到同一指纹（供 trace 去重）；只要选中版本或
 * 任一淘汰原因变化，指纹就必须变化（供回放校验）。
 * 这里用 FNV-1a 32 位，够稳且无依赖 —— 领域层不允许引入 crypto。
 */
export function selectionFingerprint(s: RuleSelection): string {
  const selected = [...s.selected]
    .map((c) => `${c.code}@${c.version}`)
    .sort()
    .join(',');
  const rejected = [...s.rejected]
    .map((r) => `${r.code}@${r.version}:${r.reason}`)
    .sort()
    .join(',');

  const payload = `${s.algorithmVersion}|${s.enterpriseId}|${s.asOfMonth}|${selected}|${rejected}`;

  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `rs1-${hash.toString(16).padStart(8, '0')}`;
}

/** 选中版本号列表，供事件载荷与 trace 使用。 */
export function selectedIds(s: RuleSelection): readonly string[] {
  return s.selected.map((c) => `${c.code}@${c.version}`);
}

/** 淘汰原因计数，供回复里「其余 N 条因…未采用」使用。 */
export function rejectionCounts(s: RuleSelection): Readonly<Record<RuleRejectionReason, number>> {
  const counts: Record<RuleRejectionReason, number> = {
    disabled: 0,
    'other-enterprise': 0,
    'not-yet-effective': 0,
    superseded: 0,
    'category-not-needed': 0,
  };
  for (const r of s.rejected) {
    counts[r.reason] += 1;
  }
  return counts;
}
