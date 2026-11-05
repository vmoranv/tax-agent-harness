/**
 * 数据集导入。
 *
 * 支持两种输入：
 * 1. **`dataset.json`（首选）** —— 把赛题 xlsx 预转成结构化 JSON。
 *    赛题提供的 xlsx 使用了 `x:` 命名空间前缀，exceljs 4.4 无法解析
 *    （`workbook.sheets` undefined）。预转后既规避了兼容性问题，
 *    也让导入过程**没有任何浮点运算** —— 金额在 JSON 里就是 `"9046.35"` 字符串。
 * 2. **标准 xlsx（可选）** —— 若 exceljs 能解析，可走 `parseStandardWorkbook`。
 *
 * 两种输入最终都产出同一个 `ImportBundle`，核对逻辑共用。
 */

import { readFile } from 'node:fs/promises';
import type {
  AccessGrant,
  BankTransaction as BankT,
  Enterprise as EnterpriseT,
  Invoice as InvoiceT,
  UserAccount as UserAccountT,
} from '@harness/domain';
import {
  accessGrant,
  BankTransaction,
  bankTransactionId,
  Enterprise,
  enterpriseName,
  Invoice,
  Money,
  parseIsoDate,
  enterpriseId as toEnterpriseId,
  invoiceNo as toInvoiceNo,
  userId as toUserId,
  UserAccount,
} from '@harness/domain';

export interface GrantSeed {
  readonly userId: string;
  readonly enterpriseId: string;
  readonly level: 'read-write' | 'read-only' | 'none';
}

export interface ImportBundle {
  readonly enterprises: EnterpriseT[];
  readonly users: ReadonlyArray<{ account: UserAccountT; grants: AccessGrant[] }>;
  readonly invoices: InvoiceT[];
  readonly bankTransactions: BankT[];
  readonly warnings: string[];
}

interface DatasetJson {
  enterprises: Array<{ id: string; legalName: string; aliases: string[] }>;
  users: Array<{ id: string; displayName: string }>;
  grants: Array<{ userId: string; enterpriseId: string; level: string }>;
  invoices: Array<{
    enterpriseId: string;
    invoiceNo: string;
    issuedOn: string;
    sellerName: string;
    itemName: string;
    amount: string;
    purpose: string | null;
    remark: string | null;
  }>;
  bankTransactions: Array<{
    enterpriseId: string;
    txnNo: string;
    tradedOn: string;
    direction: 'income' | 'expense';
    amount: string;
    counterparty: string;
    remark: string | null;
  }>;
}

export async function loadDatasetJson(path: string): Promise<ImportBundle> {
  const raw = await readFile(path, 'utf8');
  return buildBundle(JSON.parse(raw) as DatasetJson);
}

export function buildBundle(data: DatasetJson): ImportBundle {
  const warnings: string[] = [];
  const now = parseIsoDate('2026-09-30');

  const enterprises = data.enterprises.map((e) =>
    Enterprise.register(toEnterpriseId(e.id), enterpriseName(e.legalName), e.aliases),
  );

  const grantsByUser = new Map<string, AccessGrant[]>();
  for (const g of data.grants) {
    const list = grantsByUser.get(g.userId) ?? [];
    list.push(
      accessGrant({
        enterpriseId: toEnterpriseId(g.enterpriseId),
        level: g.level as 'read-write' | 'read-only' | 'none',
        grantedAt: parseIsoDate('2026-01-01'),
        grantedBy: 'system',
      }),
    );
    grantsByUser.set(g.userId, list);
  }

  const users = data.users.map((u) => ({
    account: UserAccount.register(toUserId(u.id), u.displayName, now),
    grants: grantsByUser.get(u.id) ?? [],
  }));

  const invoices: InvoiceT[] = [];
  for (const [i, inv] of data.invoices.entries()) {
    try {
      // 金额走字符串 → bigint，全程无浮点
      invoices.push(
        Invoice.create({
          enterpriseId: toEnterpriseId(inv.enterpriseId),
          invoiceNo: toInvoiceNo(inv.invoiceNo),
          issuedOn: parseIsoDate(inv.issuedOn),
          sellerName: inv.sellerName,
          itemName: inv.itemName,
          amount: Money.parse(inv.amount),
          purpose: inv.purpose,
          remark: inv.remark,
          updatedAt: now,
          updatedBy: toUserId('U001'),
        }),
      );
    } catch (err) {
      warnings.push(`发票 #${i} (${inv.enterpriseId}/${inv.invoiceNo}) 跳过：${msg(err)}`);
    }
  }

  const bankTransactions: BankT[] = [];
  for (const [i, t] of data.bankTransactions.entries()) {
    try {
      bankTransactions.push(
        BankTransaction.rehydrate({
          id: bankTransactionId(t.enterpriseId, t.txnNo),
          occurredOn: parseIsoDate(t.tradedOn),
          direction: t.direction,
          amount: Money.parse(t.amount),
          counterpartyName: t.counterparty,
          remark: t.remark,
        }),
      );
    } catch (err) {
      warnings.push(`流水 #${i} (${t.enterpriseId}/${t.txnNo}) 跳过：${msg(err)}`);
    }
  }

  return { enterprises, users, invoices, bankTransactions, warnings };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ============================ 导入后核对 ============================ */

/** 赛题官方核对页的六个数据点（已用 Decimal 重算确认）。 */
const GOLDEN: Readonly<Record<string, { inv: bigint; exp: bigint; inc: bigint }>> = {
  'C001/2026-08': { inv: 904635n, exp: 572099n, inc: 1485075n },
  'C001/2026-09': { inv: 962206n, exp: 718074n, inc: 1300050n },
  'C002/2026-08': { inv: 1366705n, exp: 934110n, inc: 1880025n },
  'C002/2026-09': { inv: 1266724n, exp: 808724n, inc: 1370075n },
};

export interface MonthCheck {
  readonly key: string;
  readonly invoiceCount: number;
  readonly bankCount: number;
  readonly invoiceTotalCents: string;
  readonly expenseCents: string;
  readonly incomeCents: string;
}

export interface VerificationSummary {
  readonly matched: boolean;
  readonly checks: MonthCheck[];
  readonly diffs: ReadonlyArray<{
    key: string;
    field: string;
    expected: string;
    actual: string;
  }>;
}

export function verifyBundle(bundle: ImportBundle): VerificationSummary {
  const checks: MonthCheck[] = [];
  const diffs: Array<{ key: string; field: string; expected: string; actual: string }> = [];

  for (const [key, expected] of Object.entries(GOLDEN)) {
    const [ent, month] = key.split('/') as [string, string];

    const invs = bundle.invoices.filter(
      (i) => i.enterpriseId === ent && i.issuedOn.startsWith(month),
    );
    const txs = bundle.bankTransactions.filter(
      (t) => t.id.startsWith(ent) && t.occurredOn.startsWith(month),
    );

    let invTotal = 0n;
    for (const i of invs) invTotal += i.amount.cents;

    let exp = 0n;
    let inc = 0n;
    for (const t of txs) {
      if (t.direction === 'expense') exp += t.amount.cents;
      else inc += t.amount.cents;
    }

    checks.push({
      key,
      invoiceCount: invs.length,
      bankCount: txs.length,
      invoiceTotalCents: invTotal.toString(),
      expenseCents: exp.toString(),
      incomeCents: inc.toString(),
    });

    if (invTotal !== expected.inv) {
      diffs.push({
        key,
        field: 'invoiceTotal',
        expected: String(expected.inv),
        actual: String(invTotal),
      });
    }
    if (exp !== expected.exp) {
      diffs.push({ key, field: 'expense', expected: String(expected.exp), actual: String(exp) });
    }
    if (inc !== expected.inc) {
      diffs.push({ key, field: 'income', expected: String(expected.inc), actual: String(inc) });
    }
  }

  return { matched: diffs.length === 0, checks, diffs };
}
