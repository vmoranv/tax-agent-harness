import type { UserRepository } from '@harness/contracts';
import type { AccessGrant, UserAccount as UserAccountT, UserId } from '@harness/domain';
import {
  type AccessLevel,
  accessGrant,
  parseIsoDate,
  enterpriseId as toEnterpriseId,
  userId as toUserId,
  UserAccount,
} from '@harness/domain';
import { type SqlDatabase, toInt, toStr } from '../database.js';

export class SqlUserRepository implements UserRepository {
  constructor(private readonly db: SqlDatabase) {}

  async findById(id: UserId): Promise<UserAccountT | null> {
    const u = this.db
      .prepare('SELECT id, display_name, status, version FROM app_user WHERE id = ?')
      .get(id);
    if (u === undefined) return null;
    const grants = await this.loadGrants(toStr(u.id));
    return UserAccount.rehydrate({
      id: toUserId(toStr(u.id)),
      displayName: toStr(u.display_name),
      status: toStr(u.status) as 'active' | 'disabled',
      grants,
      version: toInt(u.version),
    });
  }

  async listAll(): Promise<UserAccountT[]> {
    const rows = this.db
      .prepare('SELECT id, display_name, status, version FROM app_user ORDER BY id')
      .all();
    return Promise.all(
      rows.map(async (u) =>
        UserAccount.rehydrate({
          id: toUserId(toStr(u.id)),
          displayName: toStr(u.display_name),
          status: toStr(u.status) as 'active' | 'disabled',
          grants: await this.loadGrants(toStr(u.id)),
          version: toInt(u.version),
        }),
      ),
    );
  }

  private async loadGrants(userId: string): Promise<AccessGrant[]> {
    return this.db
      .prepare(
        'SELECT enterprise_id, access_level, granted_at, granted_by FROM grant WHERE user_id = ?',
      )
      .all(userId)
      .map((g) => toGrant(g));
  }
}

function toGrant(g: Record<string, unknown>): AccessGrant {
  return accessGrant({
    enterpriseId: toEnterpriseId(toStr(g.enterprise_id)),
    level: toStr(g.access_level) as AccessLevel,
    grantedAt: parseIsoDate(toStr(g.granted_at)),
    grantedBy: toStr(g.granted_by) === 'system' ? 'system' : toUserId(toStr(g.granted_by)),
  });
}
