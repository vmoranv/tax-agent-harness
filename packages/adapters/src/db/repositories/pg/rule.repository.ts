/**
 * 规则仓储（PostgreSQL）。
 *
 * `rule_doc` 与 `rule_obligation` 是 1NF 拆分后的两张表，读取时联表还原。
 * 谓词是**可执行的一等公民**，不从正文里正则抽取。
 */

import type { RuleRepository } from '@harness/contracts';
import {
  type EnterpriseId,
  Money,
  type PurposeObligation,
  parseIsoDate,
  type RuleCategory,
  type RuleCode,
  type RuleDocument as RuleDocT,
  RuleDocument,
  type RuleDocumentSnapshot,
  type RuleScope,
  type RuleStatus,
  type RuleVersion,
  ruleCode as toRuleCode,
  ruleVersion as toRuleVersion,
} from '@harness/domain';
import { and, eq, or, sql } from 'drizzle-orm';
import type { PgDatabase } from '../../pg-client.js';
import { ruleDoc, ruleObligation } from '../../schema/pg.schema.js';

type DocRow = typeof ruleDoc.$inferSelect;
type OblRow = typeof ruleObligation.$inferSelect;

export class PgRuleRepository implements RuleRepository {
  constructor(private readonly db: PgDatabase) {}

  async find(code: RuleCode, version: RuleVersion): Promise<RuleDocT | null> {
    const rows = await this.db
      .select()
      .from(ruleDoc)
      .leftJoin(
        ruleObligation,
        and(eq(ruleDoc.code, ruleObligation.code), eq(ruleDoc.version, ruleObligation.version)),
      )
      .where(and(eq(ruleDoc.code, code), eq(ruleDoc.version, version)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toDomain(row.rule_doc, row.rule_obligation);
  }

  async listCandidates(scope: EnterpriseId | 'ALL'): Promise<RuleDocT[]> {
    const where =
      scope === 'ALL'
        ? eq(ruleDoc.scopeKind, 'global')
        : or(eq(ruleDoc.scopeKind, 'global'), eq(ruleDoc.scopeEnt, scope));

    const rows = await this.db
      .select()
      .from(ruleDoc)
      .leftJoin(
        ruleObligation,
        and(eq(ruleDoc.code, ruleObligation.code), eq(ruleDoc.version, ruleObligation.version)),
      )
      .where(where);
    return rows.map((r) => toDomain(r.rule_doc, r.rule_obligation));
  }

  async listAll(): Promise<RuleDocT[]> {
    const rows = await this.db
      .select()
      .from(ruleDoc)
      .leftJoin(
        ruleObligation,
        and(eq(ruleDoc.code, ruleObligation.code), eq(ruleDoc.version, ruleObligation.version)),
      );
    return rows.map((r) => toDomain(r.rule_doc, r.rule_obligation));
  }

  async save(doc: RuleDocT): Promise<void> {
    const s = doc.toSnapshot();
    await this.db.transaction(async (tx) => {
      await tx
        .insert(ruleDoc)
        .values({
          code: s.code as string,
          version: s.version as string,
          title: s.title,
          category: s.category,
          scopeKind: s.scope.kind,
          scopeEnt: s.scope.kind === 'enterprise' ? s.scope.enterpriseId : null,
          effectiveFrom: s.effectiveFrom as string,
          status: s.status,
          body: s.body,
          supersedes: s.supersedes,
          supersededBy: s.supersededBy,
          revision: s.revision,
          updatedAt: new Date(s.updatedAt),
        })
        .onConflictDoUpdate({
          target: [ruleDoc.code, ruleDoc.version],
          set: {
            status: s.status,
            body: s.body,
            supersededBy: s.supersededBy,
            revision: s.revision,
            updatedAt: new Date(s.updatedAt),
          },
        });

      // 谓词随版本一起冻结
      if (s.obligation === null) {
        await tx
          .delete(ruleObligation)
          .where(
            and(
              eq(ruleObligation.code, s.code as string),
              eq(ruleObligation.version, s.version as string),
            ),
          );
      } else {
        await tx
          .insert(ruleObligation)
          .values({
            code: s.code as string,
            version: s.version as string,
            kind: s.obligation.kind,
            thresholdCents:
              s.obligation.kind === 'purpose_required_at_least'
                ? s.obligation.thresholdInclTax.cents
                : null,
          })
          .onConflictDoUpdate({
            target: [ruleObligation.code, ruleObligation.version],
            set: {
              kind: s.obligation.kind,
              thresholdCents: sqlThreshold(s.obligation),
            },
          });
      }
    });
  }

  async updateStatus(
    code: RuleCode,
    version: RuleVersion,
    status: 'enabled' | 'disabled',
  ): Promise<boolean> {
    const r = await this.db
      .update(ruleDoc)
      .set({ status, revision: sqlIncrement() })
      .where(and(eq(ruleDoc.code, code), eq(ruleDoc.version, version)));
    return (r.rowCount ?? 0) > 0;
  }
}

function sqlThreshold(o: PurposeObligation): bigint | null {
  return o.kind === 'purpose_required_at_least' ? o.thresholdInclTax.cents : null;
}

function sqlIncrement(): ReturnType<typeof sql<number>> {
  return sql`${ruleDoc.revision} + 1`;
}

function toDomain(d: DocRow, o: OblRow | null): RuleDocT {
  const scope: RuleScope =
    d.scopeKind === 'global'
      ? { kind: 'global' }
      : { kind: 'enterprise', enterpriseId: d.scopeEnt as never };

  let obligation: PurposeObligation | null = null;
  if (o !== null && o !== undefined) {
    obligation =
      o.kind === 'purpose_required_all'
        ? { kind: 'purpose_required_all' }
        : {
            kind: 'purpose_required_at_least',
            thresholdInclTax: Money.fromCents(
              o.thresholdCents === null ? 0n : BigInt(o.thresholdCents),
            ),
          };
  }

  const snap: RuleDocumentSnapshot = {
    code: toRuleCode(d.code),
    version: toRuleVersion(d.version),
    title: d.title,
    category: d.category as RuleCategory,
    scope,
    effectiveFrom: parseIsoDate(toDay(d.effectiveFrom)),
    status: d.status as RuleStatus,
    obligation,
    body: d.body,
    supersedes: d.supersedes === null ? null : toRuleVersion(d.supersedes),
    supersededBy: d.supersededBy === null ? null : toRuleVersion(d.supersededBy),
    revision: d.revision,
    updatedAt: parseIsoDate(toDay(d.updatedAt)),
  };
  return RuleDocument.rehydrate(snap);
}

function toDay(v: string | Date): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
}
