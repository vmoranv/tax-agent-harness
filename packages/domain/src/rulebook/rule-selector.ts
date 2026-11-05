import { RuleSelectionAmbiguousError } from '../shared/domain-error.js';
import type { EnterpriseId } from '../shared/ids.js';
import type { IsoDate, Month } from '../shared/month.js';
import { monthEndExclusive, monthStart } from '../shared/month.js';
import type { RuleCategory, RuleCitation, RuleDocument } from './rule-document.js';
import { compareVersions } from './rule-document.js';
import type { RuleRejection, RuleSelection } from './rule-selection.js';

/**
 * `scope: 'ALL'` 的哨兵值。
 *
 * 冻结签名允许 `EnterpriseId | 'ALL'`，但 `RuleSelection.enterpriseId`
 * 只有一个字段，因此 ALL 视图用该哨兵占位。它只在内存里出现，
 * 永远不会写入仓储或事件，也不会被当成合法企业号解析。
 * 这里保留字面量类型，才能让 `target !== ALL_SCOPE` 把联合类型收窄。
 */
export const ALL_SCOPE = 'ALL';
/** 同一哨兵的 EnterpriseId 形态，仅用于填充 `RuleSelection.enterpriseId`。 */
export const ALL_SCOPE_ID = 'ALL' as EnterpriseId;

const ALL_CATEGORIES: readonly RuleCategory[] = [
  'purpose-requirement',
  'amount-guidance',
  'bank-guidance',
];

function rejection(
  doc: RuleDocument,
  reason: RuleRejection['reason'],
  detail: string,
): RuleRejection {
  return { code: doc.code, version: doc.version, reason, detail };
}

function sortRejections(items: RuleRejection[]): RuleRejection[] {
  return items.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    const v = compareVersions(a.version, b.version);
    if (v !== 0) return v;
    return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
  });
}

/**
 * 三重过滤规则选择（`triple-filter-v1`）。
 *
 * 步骤（与 spec §3.3 解析算法一致，唯一口径）：
 * 1. 逐条判定，**先采集淘汰原因再筛选**，禁止静默丢弃：
 *    停用 → `disabled`；企业专属但不是本企业 → `other-enterprise`；
 *    尚未生效 → `not-yet-effective`。
 * 2. 存活候选按 `code` 分组，组内取 `effectiveFrom` 最大者。
 * 3. 组内 `effectiveFrom` 相同且版本不同 → `RuleSelectionAmbiguousError`，
 *    绝不「取第一条」。
 * 4. 组内落选版本 → `superseded`。
 * 5. 类别不在 `neededCategories` 中 → `category-not-needed`，不入选但记录。
 *
 * `neededCategories` 与 `at` 为可选扩展参数：不传时视作「所有类别都需要」，
 * 并退化为该月月初作为 `resolvedAt`（仅用于纯领域调用）；
 * 应用层必须显式传入真实时钟，冻结的三参数形状保持不变。
 */
export function selectApplicableRules(input: {
  candidates: readonly RuleDocument[];
  scope: EnterpriseId | 'ALL';
  asOfMonth: Month;
  readonly neededCategories?: readonly RuleCategory[];
  readonly at?: IsoDate;
}): RuleSelection {
  const { asOfMonth } = input;
  const target: EnterpriseId | 'ALL' = input.scope;
  const needed = input.neededCategories ?? ALL_CATEGORIES;
  const cutoff = monthEndExclusive(asOfMonth);
  const resolvedAt = input.at ?? monthStart(asOfMonth);

  const rejected: RuleRejection[] = [];
  /** code -> 通过前两重过滤的候选 */
  const alive = new Map<string, RuleDocument[]>();

  for (const doc of input.candidates) {
    if (!doc.isEnabled) {
      rejected.push(rejection(doc, 'disabled', `规则 ${doc.id} 已停用，不参与本期判定`));
      continue;
    }
    if (target !== ALL_SCOPE && !doc.isApplicableTo(target)) {
      rejected.push(
        rejection(doc, 'other-enterprise', `规则 ${doc.id} 只适用于其他企业，不适用于 ${target}`),
      );
      continue;
    }
    if (!(doc.effectiveFrom < cutoff)) {
      rejected.push(
        rejection(
          doc,
          'not-yet-effective',
          `规则 ${doc.id} 自 ${doc.effectiveFrom} 起生效，晚于 ${asOfMonth} 的月末`,
        ),
      );
      continue;
    }
    const bucket = alive.get(doc.code);
    if (bucket === undefined) {
      alive.set(doc.code, [doc]);
    } else {
      bucket.push(doc);
    }
  }

  const winners: RuleDocument[] = [];

  for (const [code, group] of alive) {
    group.sort((a, b) => {
      if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
      return -compareVersions(a.version, b.version);
    });

    const first = group[0];
    if (first === undefined) continue;

    const second = group[1];
    if (second !== undefined && second.effectiveFrom === first.effectiveFrom) {
      throw new RuleSelectionAmbiguousError(
        `规则 ${code} 在 ${asOfMonth} 存在多条同一天生效的版本，无法唯一确定`,
        {
          code,
          candidates: group.filter((d) => d.effectiveFrom === first.effectiveFrom).map((d) => d.id),
        },
      );
    }

    winners.push(first);
    for (const loser of group.slice(1)) {
      rejected.push(
        rejection(
          loser,
          'superseded',
          `规则 ${loser.id} 被同代码更高版本 ${first.id} 取代（${first.effectiveFrom} 起生效）`,
        ),
      );
    }
  }

  const selected: RuleCitation[] = [];
  for (const doc of winners) {
    if (!needed.includes(doc.category)) {
      rejected.push(
        rejection(
          doc,
          'category-not-needed',
          `规则 ${doc.id} 属于 ${doc.category}，本轮不需要该类别，故不采用`,
        ),
      );
      continue;
    }
    selected.push(doc.citation());
  }

  selected.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  return {
    enterpriseId: target === ALL_SCOPE ? ALL_SCOPE_ID : target,
    asOfMonth,
    selected,
    rejected: sortRejections(rejected),
    resolvedAt,
    algorithmVersion: 'triple-filter-v1',
  };
}
