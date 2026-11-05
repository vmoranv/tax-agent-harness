import {
  InvalidRuleError,
  InvalidTextError,
  RuleStateError,
  UnsupportedRuleError,
} from '../shared/domain-error.js';
import type { EnterpriseId, RuleCode, RuleVersion } from '../shared/ids.js';
import type { Money } from '../shared/money.js';
import type { IsoDate, Month } from '../shared/month.js';
import { monthEndExclusive } from '../shared/month.js';

/**
 * 规则的用途义务（冻结联合类型）。
 *
 * 定义在 ledger/purpose-obligation.ts 供判定使用，这里再导出，
 * 因为 spec §0 把落点写在 rulebook/rule-document.ts。
 */
export type PurposeObligation =
  | { readonly kind: 'purpose_required_all' }
  | { readonly kind: 'purpose_required_at_least'; readonly thresholdInclTax: Money };

export type { Money };

export type RuleScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'enterprise'; readonly enterpriseId: EnterpriseId };

export type RuleStatus = 'enabled' | 'disabled';
export type RuleCategory = 'purpose-requirement' | 'amount-guidance' | 'bank-guidance';

/** 回复里原样引用的规则信息。 */
export interface RuleCitation {
  readonly code: string;
  readonly title: string;
  readonly version: string;
  readonly effectiveFrom: IsoDate;
  readonly scopeLabel: string;
}

/** "R002 甲企业发票用途规则 v2.0" */
export function formatCitation(c: RuleCitation): string {
  return `${c.code} ${c.title} v${c.version}`;
}

export interface RuleDocumentSnapshot {
  readonly code: RuleCode;
  readonly version: RuleVersion;
  readonly title: string;
  readonly category: RuleCategory;
  readonly scope: RuleScope;
  readonly effectiveFrom: IsoDate;
  readonly status: RuleStatus;
  readonly obligation: PurposeObligation | null;
  readonly body: string;
  readonly supersedes: RuleVersion | null;
  readonly supersededBy: RuleVersion | null;
  readonly updatedAt: IsoDate;
  readonly revision: number;
}

export interface RuleEnabled {
  readonly type: 'rulebook.rule-enabled';
  readonly code: RuleCode;
  readonly version: RuleVersion;
  readonly occurredAt: IsoDate;
}

export interface RuleDisabled {
  readonly type: 'rulebook.rule-disabled';
  readonly code: RuleCode;
  readonly version: RuleVersion;
  readonly reason: string;
  readonly occurredAt: IsoDate;
}

export interface RuleSuperseded {
  readonly type: 'rulebook.rule-superseded';
  readonly code: RuleCode;
  readonly oldVersion: RuleVersion;
  readonly newVersion: RuleVersion;
  readonly occurredAt: IsoDate;
}

const CATEGORIES: readonly RuleCategory[] = [
  'purpose-requirement',
  'amount-guidance',
  'bank-guidance',
];

function scopeLabel(scope: RuleScope): string {
  return scope.kind === 'global' ? '全局' : scope.enterpriseId;
}

/**
 * 规则文档：聚合根。
 *
 * 不变量：
 * ① `code + version` 全局唯一，版本号只增不减；
 * ② 已发布版本的 body/scope/effectiveFrom 不可改，只能发新版本；
 * ③ `disabled` 的规则永不进入选择结果，即使生效日期已到；
 * ④ 企业专属规则不得被其他企业选中；
 * ⑤ `purpose-requirement` 必须有 obligation，其他类别必须为 null；
 * ⑥ `supersededBy` 只能指向同 code 的更高版本。
 */
export class RuleDocument {
  private constructor(
    readonly code: RuleCode,
    readonly version: RuleVersion,
    readonly title: string,
    readonly category: RuleCategory,
    private readonly scopeValue: RuleScope,
    readonly effectiveFrom: IsoDate,
    private statusValue: RuleStatus,
    readonly obligation: PurposeObligation | null,
    readonly body: string,
    readonly supersedes: RuleVersion | null,
    private supersededByValue: RuleVersion | null,
    private updatedAtValue: IsoDate,
    private revisionValue: number,
  ) {}

  static draft(input: {
    code: RuleCode;
    version: RuleVersion;
    title: string;
    category: RuleCategory;
    scope: RuleScope;
    effectiveFrom: IsoDate;
    obligation: PurposeObligation | null;
    body: string;
    supersedes: RuleVersion | null;
    updatedAt: IsoDate;
  }): RuleDocument {
    if (!CATEGORIES.includes(input.category)) {
      throw new InvalidRuleError(`未知的规则类别: ${String(input.category)}`, { code: input.code });
    }
    if (input.title.trim().length === 0) {
      throw new InvalidTextError('规则标题不能为空', { code: input.code });
    }
    if (input.body.trim().length === 0) {
      throw new InvalidTextError('规则正文不能为空', { code: input.code });
    }
    if (input.category === 'purpose-requirement' && input.obligation === null) {
      throw new InvalidRuleError('用途类规则必须给出 obligation', {
        code: input.code,
        version: input.version,
      });
    }
    if (input.category !== 'purpose-requirement' && input.obligation !== null) {
      throw new InvalidRuleError('非用途类规则不得携带 obligation', {
        code: input.code,
        version: input.version,
      });
    }
    if (input.scope.kind === 'enterprise' && input.scope.enterpriseId.length === 0) {
      throw new InvalidRuleError('企业专属规则缺少企业号', { code: input.code });
    }

    return new RuleDocument(
      input.code,
      input.version,
      input.title,
      input.category,
      input.scope,
      input.effectiveFrom,
      'enabled',
      input.obligation,
      input.body,
      input.supersedes,
      null,
      input.updatedAt,
      0,
    );
  }

  static rehydrate(s: RuleDocumentSnapshot): RuleDocument {
    return new RuleDocument(
      s.code,
      s.version,
      s.title,
      s.category,
      s.scope,
      s.effectiveFrom,
      s.status,
      s.obligation,
      s.body,
      s.supersedes,
      s.supersededBy,
      s.updatedAt,
      s.revision,
    );
  }

  /** `${code}@${version}` */
  get id(): string {
    return `${this.code}@${this.version}`;
  }

  get isEnabled(): boolean {
    return this.statusValue === 'enabled';
  }

  get status(): RuleStatus {
    return this.statusValue;
  }

  get scope(): RuleScope {
    return this.scopeValue;
  }

  get revision(): number {
    return this.revisionValue;
  }

  get supersededBy(): RuleVersion | null {
    return this.supersededByValue;
  }

  /**
   * 该规则在给定月份是否可被采用。
   *
   * 语义是「在**整个该月内**都已生效」，因此以月末为界取**严格小于**：
   * 9 月 1 日才生效的版本，不属于 8 月。若用 `<= 月末`（即 9 月 1 日），
   * 8 月就会错误地选到 9 月的规则 —— 这会直接违反
   * 「C001@2026-08 不含任何 R002」的要求。
   */
  isEffectiveAt(month: Month): boolean {
    return this.statusValue === 'enabled' && this.effectiveFrom < monthEndExclusive(month);
  }

  /** 同 code 下 other 是否是本版本的后继：版本更高且已生效。 */
  isSupersededBy(other: RuleDocument): boolean {
    if (other.code !== this.code) return false;
    return compareVersions(other.version, this.version) > 0;
  }

  /** global 对全部企业可见；enterprise 只对自身可见。 */
  isApplicableTo(enterpriseId: EnterpriseId): boolean {
    return this.scopeValue.kind === 'global' || this.scopeValue.enterpriseId === enterpriseId;
  }

  enable(at: IsoDate): RuleEnabled {
    if (this.statusValue === 'disabled') {
      this.statusValue = 'enabled';
      this.updatedAtValue = at;
      this.revisionValue += 1;
    }
    return {
      type: 'rulebook.rule-enabled',
      code: this.code,
      version: this.version,
      occurredAt: at,
    };
  }

  disable(at: IsoDate, reason: string): RuleDisabled {
    if (reason.trim().length === 0) {
      throw new InvalidTextError('停用规则必须给出原因', {
        code: this.code,
        version: this.version,
      });
    }
    this.statusValue = 'disabled';
    this.updatedAtValue = at;
    this.revisionValue += 1;
    return {
      type: 'rulebook.rule-disabled',
      code: this.code,
      version: this.version,
      reason,
      occurredAt: at,
    };
  }

  markSuperseded(by: RuleVersion, at: IsoDate): RuleSuperseded {
    if (compareVersions(by, this.version) <= 0) {
      throw new RuleStateError('supersededBy 必须指向同 code 的更高版本', {
        code: this.code,
        version: this.version,
        attempted: by,
      });
    }
    this.supersededByValue = by;
    this.updatedAtValue = at;
    this.revisionValue += 1;
    return {
      type: 'rulebook.rule-superseded',
      code: this.code,
      oldVersion: this.version,
      newVersion: by,
      occurredAt: at,
    };
  }

  citation(): RuleCitation {
    return {
      code: this.code,
      title: this.title,
      version: this.version,
      effectiveFrom: this.effectiveFrom,
      scopeLabel: scopeLabel(this.scopeValue),
    };
  }

  /** 未知 obligation 类型一律 fail closed，不退回「全部必填」。 */
  obligationOrThrow(): PurposeObligation {
    if (this.obligation === null) {
      throw new UnsupportedRuleError(`规则 ${this.id} 没有用途义务，无法自动判定`, {
        code: this.code,
        version: this.version,
      });
    }
    switch (this.obligation.kind) {
      case 'purpose_required_all':
      case 'purpose_required_at_least':
        return this.obligation;
      default: {
        const unknown: never = this.obligation;
        throw new UnsupportedRuleError(`规则 ${this.id} 的用途义务类型暂不支持自动判定`, {
          code: this.code,
          version: this.version,
          kind: (unknown as { kind?: unknown }).kind,
        });
      }
    }
  }

  toSnapshot(): RuleDocumentSnapshot {
    return {
      code: this.code,
      version: this.version,
      title: this.title,
      category: this.category,
      scope: this.scopeValue,
      effectiveFrom: this.effectiveFrom,
      status: this.statusValue,
      obligation: this.obligation,
      body: this.body,
      supersedes: this.supersedes,
      supersededBy: this.supersededByValue,
      updatedAt: this.updatedAtValue,
      revision: this.revisionValue,
    };
  }
}

/** 版本比较：'2.0' > '1.10'? 按数值分段比较，不做字符串比较。 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map((x) => Number(x));
  const pb = b.split('.').map((x) => Number(x));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}
