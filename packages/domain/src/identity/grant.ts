import { InvalidGrantError } from '../shared/domain-error.js';
import type { EnterpriseId, UserId } from '../shared/ids.js';
import type { IsoDate } from '../shared/month.js';

/**
 * 三级访问权限。
 *
 * 故意是**三态**而不是布尔：`none` 表示「明确拒绝」，
 * 而「没有授权记录」是另一种事实（数据缺失）。两者都必须拒绝访问，
 * 但诊断信息不同，因此应用层用 `AccessGrant | null` 区分。
 */
export type AccessLevel = 'read-write' | 'read-only' | 'none';

export const AccessLevel = {
  None: 'none',
  ReadOnly: 'read-only',
  ReadWrite: 'read-write',
} as const satisfies Record<string, AccessLevel>;

/** 权限强弱排序：read-write(2) > read-only(1) > none(0)。 */
export function accessRank(level: AccessLevel): 0 | 1 | 2 {
  switch (level) {
    case 'read-write':
      return 2;
    case 'read-only':
      return 1;
    case 'none':
      return 0;
  }
}

/**
 * 授权记录（02 §3.1）。
 *
 * 记录挂在 `UserAccount` 的 `enterpriseId → AccessGrant` 映射上，
 * 用户身份由聚合根持有，所以这里没有 `userId`。
 */
export interface AccessGrant {
  readonly enterpriseId: EnterpriseId;
  readonly level: AccessLevel;
  readonly grantedAt: IsoDate;
  readonly grantedBy: UserId | 'system';
}

/** 应用层简称。主名仍是 AccessGrant。 */
export type Grant = AccessGrant;

export function accessGrant(input: {
  enterpriseId: EnterpriseId;
  level: AccessLevel;
  grantedAt: IsoDate;
  grantedBy: UserId | 'system';
}): AccessGrant {
  if (input.level !== 'none' && input.level !== 'read-only' && input.level !== 'read-write') {
    throw new InvalidGrantError('未知的访问等级', { level: String(input.level) });
  }
  return Object.freeze({
    enterpriseId: input.enterpriseId,
    level: input.level,
    grantedAt: input.grantedAt,
    grantedBy: input.grantedBy,
  });
}
