/**
 * 直接读取赛题原始 xlsx（**不修改材料文件**）。
 *
 * 实现说明：
 * 赛题提供的 xlsx 使用了 `x:` 命名空间前缀，exceljs 4.x 无法解析
 * （`workbook.sheets` undefined）。改用 SheetJS（`xlsx` 0.18.5），它能正确解析。
 *
 * 两条硬规则：
 * 1. **日期用字符串直取**，本文件里的日期列已是 `YYYY-MM-DD` 文本，
 *    不做 `new Date()` 往返，杜绝时区漂移。
 * 2. **金额去掉千分位后再解析**，`"1,200.00"` → `"1200.00"`，
 *    仍走 `Money.parse`（整数分），全程零浮点。
 */

import {
  type AccessGrant,
  accessGrant,
  type BankTransaction as BankT,
  BankTransaction,
  bankTransactionId,
  Enterprise,
  type Enterprise as EnterpriseT,
  enterpriseName,
  Invoice,
  type Invoice as InvoiceT,
  Money,
  parseIsoDate,
  enterpriseId as toEnterpriseId,
  invoiceNo as toInvoiceNo,
  userId as toUserId,
  UserAccount,
  type UserAccount as UserAccountT,
} from '@harness/domain';
import XLSX from 'xlsx';
import type { ImportBundle } from './dataset.js';

type Row = readonly string[];

const AMOUNT_RE = /^-?\d+(\.\d{1,2})?$/;

/** 去掉千分位与内部空白，保留负号与小数点。 */
function normalizeAmount(raw: string): string {
  return raw.replace(/,/g, '').replace(/\s/g, '').trim();
}

function asMoney(raw: string): Money {
  const s = normalizeAmount(raw);
  if (s === '' || !AMOUNT_RE.test(s)) {
    throw new Error(`金额格式非法：${JSON.stringify(raw)}`);
  }
  return Money.parse(s);
}

/** 日期列已是 `YYYY-MM-DD`；若出现 Excel 序列号则转换（防御性）。 */
function asIsoDate(raw: string): string {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const n = Number(s);
  if (Number.isFinite(n) && n > 20000 && n < 80000) {
    // Excel 1900 日期系统序列号 → 日期（不含时区）
    const ms = Math.round((n - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  throw new Error(`无法解析日期：${JSON.stringify(raw)}`);
}

function cell(row: Row, i: number): string {
  const v = row[i];
  return v === undefined || v === null ? '' : String(v).trim();
}

/** 从表头文字定位列，避免硬编码列号。 */
function findHeader(rows: Row[], headerName: string): { rowIndex: number; cols: string[] } {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const r = rows[i] ?? [];
    if (r.some((c) => String(c).trim() === headerName)) {
      return { rowIndex: i, cols: r.map((c) => String(c).trim()) };
    }
  }
  throw new Error(`未找到表头「${headerName}」`);
}

function readSheet(wb: XLSX.WorkBook, name: string): Row[] {
  const ws = wb.Sheets[name];
  if (ws === undefined) throw new Error(`缺少工作表「${name}」`);
  return XLSX.utils.sheet_to_json<Row>(ws, {
    header: 1,
    raw: false, // 全部转成字符串：日期不丢时区、金额保留原始小数位
    defval: '',
    blankrows: false,
  });
}

/** 解析原始 xlsx，产出与 `dataset.json` 相同的 `ImportBundle`。 */
export function readXlsx(path: string): ImportBundle {
  const wb = XLSX.readFile(path);
  const warnings: string[] = [];
  const now = parseIsoDate('2026-09-30');

  /* -------------------- 企业与用户 -------------------- */
  const euRows = readSheet(wb, '企业与用户');
  const enterprises: EnterpriseT[] = [];
  const userSeeds: Array<{ id: string; name: string }> = [];
  const grantSeeds: Array<{ userId: string; enterpriseId: string; label: string }> = [];

  let enterpriseCols: string[] = [];
  for (const r of euRows) {
    const a = cell(r, 0);
    const b = cell(r, 1);
    const c = cell(r, 2);
    const d = cell(r, 3);
    if (/^C\d{3}$/.test(a)) {
      enterprises.push(
        Enterprise.register(toEnterpriseId(a), enterpriseName(b), c === '' ? [] : [c]),
      );
    } else if (a.includes('用户编号') || b.includes('用户名称')) {
      enterpriseCols = [c, d].map((col) => {
        const m = col.match(/(C\d{3})/);
        return m ? m[1]! : '';
      });
    } else if (/^U\d{3}$/.test(a)) {
      userSeeds.push({ id: a, name: b });
      const ent1 = enterpriseCols[0] || enterprises[0]?.id || '';
      const ent2 = enterpriseCols[1] || enterprises[1]?.id || '';
      if (c !== '' && ent1) grantSeeds.push({ userId: a, enterpriseId: ent1, label: c });
      if (d !== '' && ent2) grantSeeds.push({ userId: a, enterpriseId: ent2, label: d });
    }
  }

  const levelOf = (label: string): 'read-write' | 'read-only' | 'none' => {
    if (label.includes('可查看并修改') || label.includes('修改')) return 'read-write';
    if (label.includes('仅查看') || label.includes('查看')) return 'read-only';
    return 'none';
  };

  const grantsByUser = new Map<string, AccessGrant[]>();
  for (const g of grantSeeds) {
    const list = grantsByUser.get(g.userId) ?? [];
    list.push(
      accessGrant({
        enterpriseId: toEnterpriseId(g.enterpriseId),
        level: levelOf(g.label),
        grantedAt: parseIsoDate('2026-01-01'),
        grantedBy: 'system',
      }),
    );
    grantsByUser.set(g.userId, list);
  }

  const users: Array<{ account: UserAccountT; grants: AccessGrant[] }> = userSeeds.map((u) => ({
    account: UserAccount.register(toUserId(u.id), u.name, now),
    grants: grantsByUser.get(u.id) ?? [],
  }));

  /* ------------------------ 发票 ------------------------ */
  const invRows = readSheet(wb, '发票');
  const invHeader = findHeader(invRows, '企业编号');
  const inv = {
    ent: invHeader.cols.indexOf('企业编号'),
    no: invHeader.cols.indexOf('发票编号'),
    date: invHeader.cols.indexOf('开票日期'),
    seller: invHeader.cols.indexOf('销售方名称'),
    item: invHeader.cols.indexOf('项目名称（票面）'),
    amount: invHeader.cols.indexOf('价税合计（元）'),
    purpose: invHeader.cols.indexOf('用途'),
    remark: invHeader.cols.indexOf('备注'),
  };

  const invoices: InvoiceT[] = [];
  for (let i = invHeader.rowIndex + 1; i < invRows.length; i++) {
    const r = invRows[i] ?? [];
    if (!/^C\d{3}$/.test(cell(r, inv.ent))) continue;
    try {
      invoices.push(
        Invoice.create({
          enterpriseId: toEnterpriseId(cell(r, inv.ent)),
          invoiceNo: toInvoiceNo(cell(r, inv.no)),
          issuedOn: parseIsoDate(asIsoDate(cell(r, inv.date))),
          sellerName: cell(r, inv.seller),
          itemName: cell(r, inv.item),
          amount: asMoney(cell(r, inv.amount)),
          purpose: cell(r, inv.purpose) === '' ? null : cell(r, inv.purpose),
          remark: cell(r, inv.remark) === '' ? null : cell(r, inv.remark),
          updatedAt: now,
          updatedBy: toUserId('U001'),
        }),
      );
    } catch (err) {
      warnings.push(`发票第 ${i + 1} 行跳过：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* ---------------------- 银行流水 ---------------------- */
  const bankRows = readSheet(wb, '银行流水');
  const bkHeader = findHeader(bankRows, '企业编号');
  const bk = {
    ent: bkHeader.cols.indexOf('企业编号'),
    no: bkHeader.cols.indexOf('流水编号'),
    date: bkHeader.cols.indexOf('交易日期'),
    dir: bkHeader.cols.indexOf('收支方向'),
    amount: bkHeader.cols.indexOf('金额（元）'),
    party: bkHeader.cols.indexOf('对方名称'),
    remark: bkHeader.cols.indexOf('备注'),
  };

  const bankTransactions: BankT[] = [];
  for (let i = bkHeader.rowIndex + 1; i < bankRows.length; i++) {
    const r = bankRows[i] ?? [];
    if (!/^C\d{3}$/.test(cell(r, bk.ent))) continue;
    try {
      const dir = cell(r, bk.dir);
      bankTransactions.push(
        BankTransaction.rehydrate({
          id: bankTransactionId(cell(r, bk.ent), cell(r, bk.no)),
          occurredOn: parseIsoDate(asIsoDate(cell(r, bk.date))),
          direction: dir.includes('收入') ? 'income' : 'expense',
          amount: asMoney(cell(r, bk.amount)),
          counterpartyName: cell(r, bk.party),
          remark: cell(r, bk.remark) === '' ? null : cell(r, bk.remark),
        }),
      );
    } catch (err) {
      warnings.push(`流水第 ${i + 1} 行跳过：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { enterprises, users, invoices, bankTransactions, warnings };
}
