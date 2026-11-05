/**
 * 评测集共享计算库。
 *
 * 设计原则：**期望值由数据算出，不由人手写**。
 * 所有金额走整数分，任何断言的真值都能从 dataset.source.json + rules.json
 * 重新推导，避免「测试跟着 bug 一起错」。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const EVAL_DIR = join(ROOT, 'fixtures/eval');

/* ------------------------------- 基础工具 ------------------------------- */

export function readJson(relPath) {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'));
}

/** 整数分 → '9622.06'（无千分位，与 Money.format({grouped:false}) 一致） */
export function fmtCents(cents) {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const yuan = abs / 100n;
  const fen = abs % 100n;
  return `${negative ? '-' : ''}${yuan}.${fen.toString().padStart(2, '0')}`;
}

/** 整数分 → '9,622.06'（带千分位，人读格式） */
export function fmtCentsGrouped(cents) {
  const s = fmtCents(cents);
  const [y, f] = s.split('.');
  return `${y.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
}

/** 断言辅助：条件不成立直接抛，生成阶段即拦截错误数据。 */
export function invariant(cond, message, detail) {
  if (!cond) {
    const extra = detail === undefined ? '' : `\n  ${JSON.stringify(detail)}`;
    throw new Error(`[eval] ${message}${extra}`);
  }
}

/* -------------------------------- 数据装载 ------------------------------- */

export function loadDataset() {
  const data = readJson('fixtures/eval/dataset.source.json');
  invariant(data.invoices.length === 40, '发票数量应为 40', { actual: data.invoices.length });
  invariant(data.bank.length === 48, '银行流水数量应为 48', { actual: data.bank.length });
  return data;
}

export function loadRules() {
  const rules = readJson('fixtures/eval/rules.json');
  invariant(Array.isArray(rules) && rules.length === 5, '初始规则应为 5 条', {
    actual: rules.length,
  });
  return rules;
}

export function loadActors() {
  return readJson('fixtures/eval/actors.json');
}

/* ------------------------------- 领域计算 ------------------------------- */

/** 按 (enterprise, month) 汇总，返回整数分。 */
export function summarize(data, enterpriseId, month) {
  let invoiceTotal = 0n;
  let invoiceCount = 0;
  for (const inv of data.invoices) {
    if (inv.enterpriseId !== enterpriseId || inv.month !== month) continue;
    invoiceTotal += BigInt(inv.amountCents);
    invoiceCount += 1;
  }

  let expense = 0n;
  let income = 0n;
  let expenseCount = 0;
  let incomeCount = 0;
  for (const tx of data.bank) {
    if (tx.enterpriseId !== enterpriseId || tx.month !== month) continue;
    if (tx.direction === 'expense') {
      expense += BigInt(tx.amountCents);
      expenseCount += 1;
    } else {
      income += BigInt(tx.amountCents);
      incomeCount += 1;
    }
  }

  invariant(invoiceCount + 0 >= 0, 'unreachable');
  return {
    enterpriseId,
    month,
    invoiceCount,
    invoiceTotalCents: invoiceTotal,
    bankCount: expenseCount + incomeCount,
    expenseCents: expense,
    incomeCents: income,
    expenseCount,
    incomeCount,
    isEmpty: invoiceCount === 0 && expenseCount + incomeCount === 0,
  };
}

/** 规则三重过滤：停用 → 企业不匹配 → 未生效；再按 code 取最新生效版本。 */
export function selectRules(rules, enterpriseId, month, overrides = {}) {
  const monthEndExclusive = `${month}-32`; // 字典序足够比较 YYYY-MM-DD
  const effective = (code, version) => {
    const key = `${code}@${version}`;
    if (key in overrides) return overrides[key];
    const found = rules.find((r) => r.code === code && r.version === version);
    return found ? found.status : 'disabled';
  };

  const rejected = [];
  const alive = new Map();

  for (const doc of rules) {
    const status = effective(doc.code, doc.version);
    if (status !== 'enabled') {
      rejected.push({ ...doc, reason: 'disabled' });
      continue;
    }
    if (doc.scope !== 'ALL' && doc.scope !== enterpriseId) {
      rejected.push({ ...doc, reason: 'other-enterprise' });
      continue;
    }
    if (!(doc.effectiveFrom < monthEndExclusive)) {
      rejected.push({ ...doc, reason: 'not-yet-effective' });
      continue;
    }
    const bucket = alive.get(doc.code) ?? [];
    bucket.push(doc);
    alive.set(doc.code, bucket);
  }

  const selected = [];
  for (const [, group] of alive) {
    group.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
    selected.push(group[0]);
    for (const loser of group.slice(1)) rejected.push({ ...loser, reason: 'superseded' });
  }

  selected.sort((a, b) => (a.code < b.code ? -1 : 1));
  return { selected, rejected };
}

/** 取某企业某月适用的用途义务；没有则 null。 */
export function purposeObligation(rules, enterpriseId, month, overrides) {
  const { selected } = selectRules(rules, enterpriseId, month, overrides);
  const rule = selected.find((r) => r.category === 'purpose-requirement');
  return rule ?? null;
}

/**
 * 用途审计。
 * 判定顺序：已填 → present；未填且必填 → missing；未填且不要求 → allowed-empty。
 */
export function auditPurposes(data, enterpriseId, month, obligation) {
  const missing = [];
  const optional = [];
  const present = [];

  for (const inv of data.invoices) {
    if (inv.enterpriseId !== enterpriseId || inv.month !== month) continue;
    const filled = inv.purpose !== null && inv.purpose.trim() !== '';
    const amount = BigInt(inv.amountCents);

    if (filled) {
      present.push(inv);
      continue;
    }
    const required =
      obligation === null
        ? null
        : obligation.obligation.kind === 'purpose_required_all'
          ? true
          : amount >= BigInt(obligation.obligation.thresholdCents);

    if (required === null) continue;
    if (required) missing.push(inv);
    else optional.push(inv);
  }

  return { missing, optional, present };
}

/** 权限判定：返回 read-write / read-only / none。 */
export function accessLevel(actors, userId, enterpriseId) {
  const user = actors.users.find((u) => u.userId === userId);
  invariant(user !== undefined, '未知用户', { userId });
  return user.grants[enterpriseId] ?? 'none';
}

export function canRead(actors, userId, enterpriseId) {
  return accessLevel(actors, userId, enterpriseId) !== 'none';
}

export function canWrite(actors, userId, enterpriseId) {
  return accessLevel(actors, userId, enterpriseId) === 'read-write';
}

/* ------------------------------ 场景常量 ------------------------------- */

export const ENTERPRISES = ['C001', 'C002'];
export const MONTHS = ['2026-07', '2026-08', '2026-09'];
export const ENTERPRISE_LABEL = { C001: '甲企业', C002: '乙企业' };

/** 9 月的缺项真值（默认规则状态下）。生成时校验，防止与 Excel 漂移。 */
export const EXPECTED_SEPTEMBER = {
  C001: { missing: ['F002', 'F003', 'F004', 'F006', 'F009'], optional: [] },
  C002: { missing: ['F002', 'F005', 'F006'], optional: ['F001', 'F004', 'F009'] },
};
