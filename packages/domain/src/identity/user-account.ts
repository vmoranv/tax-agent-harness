import { InvalidGrantError, UserDisabledError } from '../shared/domain-error.js';
import type { EnterpriseId, UserId } from '../shared/ids.js';
import type { IsoDate } from '../shared/month.js';
import type { AccessGrant, AccessLevel } from './grant.js';
import { accessGrant, accessRank } from './grant.js';

/** 授权成功事件（02 §3.1）。 */
export interface AccessGranted {
  readonly type: 'identity.access-granted';
  readonly userId: UserId;
  readonly enterpriseId: EnterpriseId;
  readonly level: AccessLevel;
  readonly grantedBy: UserId | 'system';
  readonly occurredAt: IsoDate;
}

/** 撤销授权事件。 */
export interface AccessRevoked {
  readonly type: 'identity.access-revoked';
  readonly userId: UserId;
  readonly enterpriseId: EnterpriseId;
  readonly previousLevel: AccessLevel;
  readonly occurredAt: IsoDate;
}

/** 账号快照，用于 rehydrate。 */
export interface UserAccountSnapshot {
  readonly id: UserId;
  readonly displayName: string;
  readonly status: 'active' | 'disabled';
  readonly grants: readonly AccessGrant[];
  readonly version: number;
}

/**
 * 用户账号聚合根。
 *
 * 不变量：
 * ① id 不可变；② 同一企业至多一条 grant，重复授权就地更新等级；
 * ③ 只有 grant/revoke 改变权限，对话文本永不成为权限来源；
 * ④ disabled 时 `levelFor` 恒为 `none`，历史 grant 保留但不生效；
 * ⑤ 等级只能是三态之一；⑥ revoke 后再次授权须重记授予人与时间。
 */
export class UserAccount {
  private constructor(
    readonly id: UserId,
    readonly displayName: string,
    private statusValue: 'active' | 'disabled',
    private readonly grants: Map<string, AccessGrant>,
    private versionValue: number,
  ) {}

  get version(): number {
    return this.versionValue;
  }

  static register(id: UserId, displayName: string, _at: IsoDate): UserAccount {
    return new UserAccount(id, displayName, 'active', new Map(), 0);
  }

  static rehydrate(snapshot: UserAccountSnapshot): UserAccount {
    const map = new Map<string, AccessGrant>();
    for (const g of snapshot.grants) {
      map.set(g.enterpriseId, g);
    }
    return new UserAccount(
      snapshot.id,
      snapshot.displayName,
      snapshot.status,
      map,
      snapshot.version,
    );
  }

  /** 授予或更新等级。返回事件而不是 void：调用方负责收集。 */
  grant(
    enterprise: EnterpriseId,
    level: AccessLevel,
    by: UserId | 'system',
    at: IsoDate,
  ): AccessGranted {
    this.assertActive();
    this.grants.set(
      enterprise,
      accessGrant({ enterpriseId: enterprise, level, grantedAt: at, grantedBy: by }),
    );
    this.bump();
    return {
      type: 'identity.access-granted',
      userId: this.id,
      enterpriseId: enterprise,
      level,
      grantedBy: by,
      occurredAt: at,
    };
  }

  revoke(enterprise: EnterpriseId, at: IsoDate): AccessRevoked {
    this.assertActive();
    const previous = this.grants.get(enterprise);
    if (previous === undefined) {
      throw new InvalidGrantError(`用户 ${this.id} 未在 ${enterprise} 上持有授权`, {
        userId: this.id,
        enterpriseId: enterprise,
      });
    }
    this.grants.delete(enterprise);
    this.bump();
    return {
      type: 'identity.access-revoked',
      userId: this.id,
      enterpriseId: enterprise,
      previousLevel: previous.level,
      occurredAt: at,
    };
  }

  /**
   * 当前生效等级。停用或从未授权都返回 'none'。
   * 需要区分「无记录」与「明确 none」时用 `grantFor`。
   */
  levelFor(enterprise: EnterpriseId): AccessLevel {
    if (this.statusValue !== 'active') return 'none';
    return this.grants.get(enterprise)?.level ?? 'none';
  }

  /** 原始授权记录；无记录返回 null。应用层据此构造 `AccessGrant | null`。 */
  grantFor(enterprise: EnterpriseId): AccessGrant | null {
    if (this.statusValue !== 'active') return null;
    return this.grants.get(enterprise) ?? null;
  }

  grantsFor(): readonly AccessGrant[] {
    return [...this.grants.values()].sort(
      (a, b) =>
        accessRank(b.level) - accessRank(a.level) || a.enterpriseId.localeCompare(b.enterpriseId),
    );
  }

  isActive(): boolean {
    return this.statusValue === 'active';
  }

  disable(_at: IsoDate): void {
    if (this.statusValue === 'disabled') return;
    this.statusValue = 'disabled';
    this.bump();
  }

  assertActive(): void {
    if (this.statusValue !== 'active') {
      throw new UserDisabledError(`用户 ${this.id} 已停用`, { userId: this.id });
    }
  }

  toSnapshot(): UserAccountSnapshot {
    return {
      id: this.id,
      displayName: this.displayName,
      status: this.statusValue,
      grants: this.grantsFor().map((g) => ({ ...g })),
      version: this.versionValue,
    };
  }

  private bump(): void {
    this.versionValue += 1;
  }
}
