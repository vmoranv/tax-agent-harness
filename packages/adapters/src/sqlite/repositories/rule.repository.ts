import type { RuleRepository } from '@harness/contracts';
import type {
  EnterpriseId,
  PurposeObligation,
  RuleCategory,
  RuleCode,
  RuleDocument as RuleDocT,
  RuleScope,
  RuleStatus,
  RuleVersion,
} from '@harness/domain';
import {
  Money,
  parseIsoDate,
  parseMonth,
  RuleDocument,
  enterpriseId as toEnterpriseId,
  ruleCode as toRuleCode,
  ruleVersion as toRuleVersion,
} from '@harness/domain';
import { type SqlDatabase, toInt, toStr, toStrOrNull } from '../database.js';

export class SqlRuleRepository implements RuleRepository {
  constructor(private readonly db: SqlDatabase) {}

  async find(code: RuleCode, version: RuleVersion): Promise<RuleDocT | null> {
    const r = this.db.prepare(`${SELECT_RULE} WHERE code = ? AND version = ?`).get(code, version);
    return r === undefined ? null : toRule(r);
  }

  async listCandidates(scope: EnterpriseId | 'ALL'): Promise<RuleDocT[]> {
    const rows = this.db
      .prepare(`${SELECT_RULE} WHERE scope_kind = 'global' OR scope_ent = ?`)
      .all(scope === 'ALL' ? '' : scope);
    return rows.map(toRule);
  }

  async listAll(): Promise<RuleDocT[]> {
    return this.db.prepare(SELECT_RULE).all().map(toRule);
  }

  async save(doc: RuleDocT): Promise<void> {
    const s = doc.toSnapshot();
    this.db
      .prepare(
        `INSERT INTO rule_doc (code, version, title, category, scope_kind, scope_ent,
            effective_from, status, obligation, body, supersedes, superseded_by, revision, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (code, version) DO UPDATE SET
           status = excluded.status,
           obligation = excluded.obligation,
           body = excluded.body,
           superseded_by = excluded.superseded_by,
           revision = excluded.revision,
           updated_at = excluded.updated_at`,
      )
      .run(
        s.code,
        s.version,
        s.title,
        s.category,
        s.scope.kind,
        s.scope.kind === 'enterprise' ? s.scope.enterpriseId : null,
        s.effectiveFrom,
        s.status,
        JSON.stringify(serializeObligation(s.obligation)),
        s.body,
        s.supersedes,
        s.supersededBy,
        s.revision,
        s.updatedAt,
      );
  }

  async updateStatus(
    code: RuleCode,
    version: RuleVersion,
    status: 'enabled' | 'disabled',
  ): Promise<boolean> {
    const r = this.db
      .prepare(
        'UPDATE rule_doc SET status = ?, revision = revision + 1 WHERE code = ? AND version = ?',
      )
      .run(status, code, version);
    return r.changes > 0;
  }
}
const SELECT_RULE = `SELECT code, version, title, category, scope_kind, scope_ent,
  effective_from, status, obligation, body, supersedes, superseded_by, revision, updated_at
  FROM rule_doc`;

function toRule(r: Record<string, unknown>): RuleDocT {
  const raw = JSON.parse(toStr(r.obligation ?? 'null')) as null | {
    kind: string;
    thresholdCents?: string;
  };
  const scope: RuleScope =
    toStr(r.scope_kind) === 'global'
      ? { kind: 'global' }
      : { kind: 'enterprise', enterpriseId: toEnterpriseId(toStr(r.scope_ent)) };

  let obligation: PurposeObligation | null = null;
  if (raw !== null) {
    obligation =
      raw.kind === 'purpose_required_all'
        ? { kind: 'purpose_required_all' }
        : {
            kind: 'purpose_required_at_least',
            thresholdInclTax: Money.fromCents(BigInt(raw.thresholdCents ?? '0')),
          };
  }

  return RuleDocument.rehydrate({
    code: toRuleCode(toStr(r.code)),
    version: toRuleVersion(toStr(r.version)),
    title: toStr(r.title),
    category: toStr(r.category) as RuleCategory,
    scope,
    effectiveFrom: parseIsoDate(toStr(r.effective_from)),
    status: toStr(r.status) as RuleStatus,
    obligation,
    body: toStr(r.body),
    supersedes: toStrOrNull(r.supersedes) as RuleVersion | null,
    supersededBy: toStrOrNull(r.superseded_by) as RuleVersion | null,
    revision: toInt(r.revision),
    updatedAt: parseIsoDate(toStr(r.updated_at)),
  });
}

function serializeObligation(o: PurposeObligation | null): unknown {
  if (o === null) return null;
  if (o.kind === 'purpose_required_all') return { kind: o.kind };
  return { kind: o.kind, thresholdCents: o.thresholdInclTax.cents.toString() };
}

export { parseMonth };
