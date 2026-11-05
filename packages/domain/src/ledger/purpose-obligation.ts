import { UnsupportedRuleError } from '../shared/domain-error.js';
import { Money } from '../shared/money.js';
import { isBlankText } from '../shared/text.js';
import type { Invoice } from './invoice.js';

/**
 * 规则的用途义务（冻结联合类型）。
 *
 * 新增 kind 必须同时补全 `auditPurpose` 的穷尽分支，
 * 否则 `never` 检查会拒绝编译；运行时遇到未知 kind 一律 fail closed。
 */
export type PurposeObligation =
  | { readonly kind: 'purpose_required_all' }
  | { readonly kind: 'purpose_required_at_least'; readonly thresholdInclTax: Money };

/** 单张发票在给定义务下的判定结果。 */
export type PurposeVerdict = 'missing' | 'present' | 'allowed-empty';

/**
 * 用途是否为空：null、空串、全空白都算空。
 *
 * 实现委托给 `shared/text.ts`，避免 invoice ↔ purpose-obligation 循环依赖。
 * 对外签名保持不变，调用方无需改动。
 */
export function isBlankPurpose(purpose: string | null): boolean {
  return isBlankText(purpose);
}

/**
 * 判定单张发票是否满足用途义务。
 *
 * 判定表（02-domain-model.md §用途审计判定表，自上而下匹配）：
 * ① `purpose !== null` → `present`，**先于金额判定**——已填写就是 present，
 *    哪怕金额低于门槛（把已填的写成 allowed-empty 是语义错误）；
 * ② `purpose === null` 且必填且达到门槛 → `missing`；
 * ③ `purpose === null` 且未达门槛 → `allowed-empty`。
 *
 * 因此 `purpose_required_at_least`：含税金额 **>=** 门槛才要求用途，
 * 门槛本身必须填（1000.00 是 required，999.99 才是 allowed-empty）。
 * 判定只看发票当前状态，不看历史；`present` 与 `allowed-empty` 都算合规。
 */
export function auditPurpose(inv: Invoice, ob: PurposeObligation): PurposeVerdict {
  const filled = !isBlankPurpose(inv.purpose);

  switch (ob.kind) {
    case 'purpose_required_all':
      return filled ? 'present' : 'missing';

    case 'purpose_required_at_least':
      if (filled) return 'present';
      return inv.amount.gte(ob.thresholdInclTax) ? 'missing' : 'allowed-empty';

    default: {
      const unknownKind: never = ob;
      throw new UnsupportedRuleError(
        `无法处理的用途义务类型: ${String((unknownKind as { kind?: unknown }).kind)}`,
        { obligation: (unknownKind as { kind?: unknown }).kind },
      );
    }
  }
}

/** 是否算「合规」（present 或 allowed-empty）。 */
export function isCompliant(verdict: PurposeVerdict): boolean {
  return verdict === 'present' || verdict === 'allowed-empty';
}

/** 构造门槛义务的便捷函数：金额以「元」字符串给出，避免测试里手写分。 */
export function atLeast(yuan: string): PurposeObligation {
  return { kind: 'purpose_required_at_least', thresholdInclTax: Money.parse(yuan) };
}

export const PURPOSE_REQUIRED_ALL: PurposeObligation = { kind: 'purpose_required_all' };
