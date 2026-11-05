import type { AccessGrantRepository } from '@harness/contracts';
import type { AccessGrant, EnterpriseId, UserId } from '@harness/domain';
import {
  type AccessLevel,
  accessGrant,
  parseIsoDate,
  enterpriseId as toEnterpriseId,
  userId as toUserId,
} from '@harness/domain';
import { type SqlDatabase, toStr } from '../database.js';

export class SqlGrantRepository implements AccessGrantRepository {
  constructor(private readonly db: SqlDatabase) {}

  async find(userId: UserId, enterpriseId: EnterpriseId): Promise<AccessGrant | null> {
    const r = this.db
      .prepare(
        'SELECT enterprise_id, access_level, granted_at, granted_by FROM grant WHERE user_id = ? AND enterprise_id = ?',
      )
      .get(userId, enterpriseId);
    return r === undefined ? null : toGrant(r);
  }

  async listByUser(userId: UserId): Promise<AccessGrant[]> {
    return this.db
      .prepare(
        'SELECT enterprise_id, access_level, granted_at, granted_by FROM grant WHERE user_id = ?',
      )
      .all(userId)
      .map(toGrant);
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
