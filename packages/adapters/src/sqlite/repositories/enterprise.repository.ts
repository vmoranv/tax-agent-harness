import type { EnterpriseRepository } from '@harness/contracts';
import type { EnterpriseId, Enterprise as EnterpriseT } from '@harness/domain';
import { Enterprise, enterpriseId as toEnterpriseId } from '@harness/domain';
import { type SqlDatabase, toInt, toStr } from '../database.js';

export class SqlEnterpriseRepository implements EnterpriseRepository {
  constructor(private readonly db: SqlDatabase) {}

  async findById(id: EnterpriseId): Promise<EnterpriseT | null> {
    const r = this.db
      .prepare('SELECT id, legal_name, aliases, status, version FROM enterprise WHERE id = ?')
      .get(id);
    return r === undefined ? null : toEnterprise(r);
  }

  async listAll(): Promise<EnterpriseT[]> {
    return this.db
      .prepare('SELECT id, legal_name, aliases, status, version FROM enterprise ORDER BY id')
      .all()
      .map(toEnterprise);
  }

  async resolveByName(name: string): Promise<EnterpriseT | null> {
    const all = await this.listAll();
    return all.find((e) => e.legalName === name || e.aliasesFor().includes(name)) ?? null;
  }
}

function toEnterprise(r: Record<string, unknown>): EnterpriseT {
  return Enterprise.rehydrate({
    id: toEnterpriseId(toStr(r.id)),
    legalName: toStr(r.legal_name) as never,
    aliases: JSON.parse(toStr(r.aliases ?? '[]')) as string[],
    status: toStr(r.status) as 'active' | 'inactive',
    version: toInt(r.version),
  });
}
