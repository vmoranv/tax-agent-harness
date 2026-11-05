/**
 * 数据装载：把 `dataset.json` 与 `rules.seed.json` 写入数据库。
 *
 * 这是「一次性初始化」路径，不走用例层（用例层要求事务内只有业务操作）。
 * 装载完成后**必须**跑 `verifyBundle` 核对，不一致就整体回滚。
 */

import { readFileSync } from 'node:fs';
import {
  Money,
  type PurposeObligation,
  parseIsoDate,
  type RuleCategory,
  RuleDocument,
  type RuleScope,
  ruleCode as toRuleCode,
  ruleVersion as toRuleVersion,
} from '@harness/domain';
import {
  type ImportBundle,
  loadDatasetJson,
  type VerificationSummary,
  verifyBundle,
} from './excel/dataset.js';
import { readXlsx } from './excel/xlsx-reader.js';
import type { SqlDatabase } from './sqlite/database.js';

interface RuleSeed {
  code: string;
  version: string;
  title: string;
  category: string;
  scope: { kind: 'global' } | { kind: 'enterprise'; enterpriseId: string };
  effectiveFrom: string;
  status: 'enabled' | 'disabled';
  obligation:
    | null
    | { kind: 'purpose_required_all' }
    | { kind: 'purpose_required_at_least'; thresholdInclTax: string };
  body: string;
  supersedes?: string | null;
  supersededBy?: string | null;
}

export interface LoadResult {
  readonly enterprises: number;
  readonly users: number;
  readonly grants: number;
  readonly invoices: number;
  readonly bankTransactions: number;
  readonly rules: number;
  readonly verification: VerificationSummary;
  readonly warnings: readonly string[];
}

/** 装载数据；核对不通过则抛错（调用方应回滚或删库重建）。 */
export async function loadAll(
  db: SqlDatabase,
  datasetPath: string,
  rulesPath: string,
): Promise<LoadResult> {
  // 按扩展名分流：xlsx 直读原始材料，json 走预转格式
  const bundle: ImportBundle = /\.[xX][lL][sS][xX]$/.test(datasetPath)
    ? readXlsx(datasetPath)
    : await loadDatasetJson(datasetPath);
  const rules = parseRuleSeed(rulesPath);

  // 先核对再落库 —— 不在错误的输入上建库
  const verification = verifyBundle(bundle);
  if (!verification.matched) {
    throw new Error(`数据核对失败，拒绝装载：${JSON.stringify(verification.diffs, null, 2)}`);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    let enterprises = 0;
    for (const e of bundle.enterprises) {
      db.prepare(
        `INSERT INTO enterprise (id, legal_name, aliases, status, version, created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT (id) DO UPDATE SET legal_name = excluded.legal_name,
           aliases = excluded.aliases`,
      ).run(e.id, e.legalName, JSON.stringify(e.aliasesFor()), e.status, e.version, '2026-01-01');
      enterprises += 1;
    }

    let users = 0;
    let grants = 0;
    for (const u of bundle.users) {
      db.prepare(
        `INSERT INTO app_user (id, display_name, status, version, created_at)
         VALUES (?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name`,
      ).run(u.account.id, u.account.displayName, 'active', 0, '2026-01-01');
      users += 1;

      for (const g of u.grants) {
        db.prepare('INSERT OR REPLACE INTO grant VALUES (?,?,?,?,?)').run(
          u.account.id,
          g.enterpriseId,
          g.level,
          g.grantedAt,
          typeof g.grantedBy === 'string' ? g.grantedBy : String(g.grantedBy),
        );
        grants += 1;
      }
    }

    const invStmt = db.prepare(
      `INSERT INTO invoice (enterprise_id, invoice_no, issued_on, issued_month,
          seller_name, item_name, amount_cents, purpose, remark, version, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (enterprise_id, invoice_no) DO UPDATE SET
         purpose = excluded.purpose, remark = excluded.remark,
         version = excluded.version, updated_at = excluded.updated_at`,
    );
    for (const inv of bundle.invoices) {
      const s = inv.snapshot();
      invStmt.run(
        s.enterpriseId,
        s.invoiceNo,
        s.issuedOn,
        s.issuedOn.slice(0, 7),
        s.sellerName,
        s.itemName,
        Number(s.amount.cents),
        s.purpose,
        s.remark,
        s.version,
        s.updatedAt,
        s.updatedBy,
      );
    }

    const bankStmt = db.prepare(
      `INSERT INTO bank_txn (enterprise_id, txn_no, traded_on, traded_month,
          direction, amount_cents, counterparty, remark)
       VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (enterprise_id, txn_no) DO NOTHING`,
    );
    for (const t of bundle.bankTransactions) {
      const s = t.toSnapshot();
      const idx = s.id.indexOf('/');
      bankStmt.run(
        s.id.slice(0, idx),
        s.id.slice(idx + 1),
        s.occurredOn,
        s.occurredOn.slice(0, 7),
        s.direction,
        Number(s.amount.cents),
        s.counterpartyName,
        s.remark,
      );
    }

    const ruleStmt = db.prepare(
      `INSERT INTO rule_doc (code, version, title, category, scope_kind, scope_ent,
          effective_from, status, obligation, body, supersedes, superseded_by, revision, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (code, version) DO UPDATE SET
         status = excluded.status, obligation = excluded.obligation,
         body = excluded.body, superseded_by = excluded.superseded_by`,
    );
    for (const r of rules) {
      ruleStmt.run(
        r.code,
        r.version,
        r.title,
        r.category,
        r.scope.kind,
        r.scope.kind === 'enterprise' ? r.scope.enterpriseId : null,
        r.effectiveFrom,
        r.status,
        r.obligation === null ? 'null' : JSON.stringify(serializeObligation(r.obligation)),
        r.body,
        r.supersedes ?? null,
        r.supersededBy ?? null,
        0,
        '2026-09-30',
      );
    }

    db.exec('COMMIT');

    return {
      enterprises,
      users,
      grants,
      invoices: bundle.invoices.length,
      bankTransactions: bundle.bankTransactions.length,
      rules: rules.length,
      verification,
      warnings: bundle.warnings,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function serializeObligation(o: PurposeObligation): unknown {
  return o.kind === 'purpose_required_all'
    ? { kind: o.kind }
    : { kind: o.kind, thresholdCents: o.thresholdInclTax.cents.toString() };
}

export function parseRuleSeed(path: string): RuleDocument[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { rules: RuleSeed[] };
  return raw.rules.map((r) => {
    const obligation =
      r.obligation === null
        ? null
        : r.obligation.kind === 'purpose_required_all'
          ? ({ kind: 'purpose_required_all' } as PurposeObligation)
          : ({
              kind: 'purpose_required_at_least',
              thresholdInclTax: Money.parse(r.obligation.thresholdInclTax),
            } as PurposeObligation);

    const doc = RuleDocument.draft({
      code: toRuleCode(r.code),
      version: toRuleVersion(r.version),
      title: r.title,
      category: r.category as RuleCategory,
      scope: r.scope as RuleScope,
      effectiveFrom: parseIsoDate(r.effectiveFrom),
      obligation,
      body: r.body,
      supersedes:
        r.supersedes === null || r.supersedes === undefined ? null : toRuleVersion(r.supersedes),
      updatedAt: parseIsoDate('2026-09-30'),
    });

    if (r.status === 'disabled') {
      doc.disable(parseIsoDate('2026-09-01'), '被后续版本取代');
    }
    return doc;
  });
}
