import type { EnterpriseId } from '../shared/ids.js';
import type { Grant } from './grant.js';

export type { AccessLevel, Grant } from './grant.js';

/** 唯一允许通过领域方法变更的发票字段。 */
export type MutableField = 'purpose' | 'remark';

const MUTABLE_FIELDS: ReadonlySet<string> = new Set<string>(['purpose', 'remark']);

/** 拒绝原因。判定顺序即此枚举顺序。 */
export type DenialReason =
  | 'no_grant'
  | 'enterprise_not_accessible'
  | 'read_only_enterprise'
  | 'field_not_mutable';

/**
 * 访问决策。
 *
 * 允许分支额外携带 `enterpriseId` / `field` 两个可选字段：
 * 它们是 decideWrite 已掌握的事实，领域对象据此校验「决策确实
 * 是针对本企业、本字段作出的」，防止把 A 企业的写权限套到 B 企业。
 * 两个字段可选，因此 `{ allowed: true }` 仍然合法，冻结形状不变。
 */
export type AccessDecision =
  | { allowed: true; readonly enterpriseId?: EnterpriseId; readonly field?: MutableField }
  | { allowed: false; reason: DenialReason; message: string };

function deny(reason: DenialReason, message: string): AccessDecision {
  return { allowed: false, reason, message };
}

/**
 * 读权限判定。
 *
 * `none` 的判定先于任何「对象是否存在」的检查：
 * 上层拿到 denied 后不得再查询企业/发票，否则会通过
 * 「不存在」与「无权」的差异泄漏对象存在性。
 */
export function decideRead(grant: Grant | null): AccessDecision {
  if (grant === null) {
    return deny('no_grant', '没有该企业的授权记录');
  }
  if (grant.level === 'none') {
    return deny('enterprise_not_accessible', '对该企业无权访问');
  }
  return { allowed: true };
}

/**
 * 写权限判定。
 *
 * 顺序固定：no_grant → enterprise_not_accessible → read_only_enterprise → field_not_mutable。
 * 字段白名单放在权限之后，避免通过「字段不可改」反推企业是否存在/可访问。
 */
export function decideWrite(grant: Grant | null, field: MutableField): AccessDecision {
  const read = decideRead(grant);
  if (!read.allowed) {
    return read;
  }
  if (grant !== null && grant.level === 'read-only') {
    return deny('read_only_enterprise', '对该企业只有查看权限，不能修改');
  }
  if (!MUTABLE_FIELDS.has(field)) {
    return deny('field_not_mutable', `字段 ${String(field)} 不允许修改，只能改用途和备注`);
  }
  return grant === null
    ? { allowed: true, field }
    : { allowed: true, field, enterpriseId: grant.enterpriseId };
}

/** 运行时校验字段名（用于来自外部输入的未知值）。 */
export function isMutableField(raw: unknown): raw is MutableField {
  return typeof raw === 'string' && MUTABLE_FIELDS.has(raw);
}
