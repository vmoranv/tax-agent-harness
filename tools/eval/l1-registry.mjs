/**
 * L1 用例执行器：把声明式用例落到 `@harness/domain` 的真实导出上。
 *
 * 为什么用 `custom` 而不是让每条用例写一段代码：
 * 用例清单要能被非程序员（评委、文档）读懂，因此 `input`/`expect`
 * 保持纯数据；只有需要组装多个对象时，才在下面的 registry 里写一次。
 */

import * as D from '../../packages/domain/dist/index.js';
import { fmtCents } from './lib.mjs';

const CTX = () => ({
  userId: D.userId('U001'),
  enterpriseId: D.enterpriseId('C001'),
  at: D.parseIsoDate('2026-09-10'),
  req: (s) => D.parseRequestId(s),
});

function makeInvoice(overrides = {}) {
  const { userId, at } = CTX();
  return D.Invoice.create({
    enterpriseId: D.enterpriseId(overrides.enterpriseId ?? 'C001'),
    invoiceNo: D.invoiceNo(overrides.invoiceNo ?? 'F002'),
    issuedOn: D.parseIsoDate(overrides.issuedOn ?? '2026-09-08'),
    sellerName: '书林图文（模拟）',
    itemName: '复印纸、打印服务',
    amount: D.Money.parse(overrides.amount ?? '800.00'),
    purpose: overrides.purpose ?? null,
    remark: overrides.remark ?? null,
    updatedAt: at,
    updatedBy: userId,
  });
}

function grantFor(level, enterpriseId = 'C001') {
  return D.accessGrant({
    enterpriseId: D.enterpriseId(enterpriseId),
    level,
    grantedAt: D.parseIsoDate('2026-01-01'),
    grantedBy: 'system',
  });
}

const OBLIGATION = {
  'R002@1.0': { kind: 'purpose_required_at_least', thresholdInclTax: D.Money.parse('1000.00') },
  'R002@2.0': { kind: 'purpose_required_all' },
  'R003@1.0': { kind: 'purpose_required_at_least', thresholdInclTax: D.Money.parse('1000.00') },
};

function ruleDoc(items) {
  return items.map((r) =>
    D.RuleDocument.rehydrate({
      code: D.ruleCode(r.code),
      version: D.ruleVersion(r.version),
      title: r.title,
      category: r.category,
      scope:
        r.scope === 'ALL'
          ? { kind: 'global' }
          : { kind: 'enterprise', enterpriseId: D.enterpriseId(r.scope) },
      effectiveFrom: D.parseIsoDate(r.effectiveFrom),
      status: r.status,
      obligation: OBLIGATION[`${r.code}@${r.version}`] ?? null,
      body: r.body ?? `${r.title} ${r.version} 正文`,
      supersedes: null,
      supersededBy: null,
      updatedAt: D.parseIsoDate('2026-01-01'),
      revision: 0,
    }),
  );
}

const RULESET = [
  {
    code: 'R001',
    version: '1.0',
    title: '金额统计说明',
    category: 'amount-guidance',
    scope: 'ALL',
    effectiveFrom: '2026-01-01',
    status: 'enabled',
  },
  {
    code: 'R002',
    version: '1.0',
    title: '甲企业发票用途规则',
    category: 'purpose-requirement',
    scope: 'C001',
    effectiveFrom: '2026-08-01',
    status: 'disabled',
  },
  {
    code: 'R002',
    version: '2.0',
    title: '甲企业发票用途规则',
    category: 'purpose-requirement',
    scope: 'C001',
    effectiveFrom: '2026-09-01',
    status: 'enabled',
  },
  {
    code: 'R003',
    version: '1.0',
    title: '乙企业发票用途规则',
    category: 'purpose-requirement',
    scope: 'C002',
    effectiveFrom: '2026-08-01',
    status: 'enabled',
  },
  {
    code: 'R004',
    version: '1.0',
    title: '银行资料说明',
    category: 'bank-guidance',
    scope: 'ALL',
    effectiveFrom: '2026-01-01',
    status: 'enabled',
  },
];

function select(scope, month, mutate) {
  const docs = ruleDoc(RULESET.map((r) => (mutate ? mutate({ ...r }) : r)));
  return D.selectApplicableRules({
    candidates: docs,
    scope: D.enterpriseId(scope),
    asOfMonth: D.parseMonth(month),
    at: D.parseIsoDate(`${month}-10`),
  });
}

const ids = (sel) => sel.selected.map((c) => `${c.code}@${c.version}`);
const rejectedKeys = (sel) => sel.rejected.map((r) => `${r.code}@${r.version}:${r.reason}`);

/** 每个 custom key 返回 `{ actual }`，由外层与 expect 比对。 */
export const l1Registry = {
  /* Money */
  floatTrap() {
    const sum = D.Money.parse('0.1').add(D.Money.parse('0.2'));
    return { text: sum.format({ grouped: false }) };
  },

  /* InvoiceId */
  differentEnterpriseSameNo() {
    const a = D.InvoiceId.of(D.enterpriseId('C001'), D.invoiceNo('F002'));
    const b = D.InvoiceId.of(D.enterpriseId('C002'), D.invoiceNo('F002'));
    return { value: a.equals(b) };
  },
  sameIdEquals() {
    const a = D.InvoiceId.of(D.enterpriseId('C001'), D.invoiceNo('F002'));
    const b = D.InvoiceId.parse('C001/F002');
    return { value: a.equals(b) };
  },

  /* Invoice */
  changePurposeAllowed() {
    const { userId, at, req } = CTX();
    const inv = makeInvoice();
    const dec = D.decideWrite(grantFor('read-write'), 'purpose');
    const out = inv.changePurpose('采购', dec, req('req-1'), userId, at);
    return {
      purpose: inv.purpose,
      version: inv.version,
      event: out.status === 'applied' ? out.event.type : null,
    };
  },
  changePurposeBlank() {
    const { userId, at, req } = CTX();
    const inv = makeInvoice({ purpose: '原有用途' });
    inv.changePurpose(
      '   ',
      D.decideWrite(grantFor('read-write'), 'purpose'),
      req('req-2'),
      userId,
      at,
    );
    return { purpose: inv.purpose };
  },
  purposeTooLong() {
    const { userId, at, req } = CTX();
    const inv = makeInvoice();
    inv.changePurpose(
      '长'.repeat(201),
      D.decideWrite(grantFor('read-write'), 'purpose'),
      req('req-3'),
      userId,
      at,
    );
    return {};
  },
  changePurposeDenied() {
    const { userId, at, req } = CTX();
    const inv = makeInvoice();
    inv.changePurpose(
      '采购',
      D.decideWrite(grantFor('read-only'), 'purpose'),
      req('req-4'),
      userId,
      at,
    );
    return {};
  },
  changePurposeWrongField() {
    const { userId, at, req } = CTX();
    const inv = makeInvoice();
    inv.changePurpose(
      '采购',
      D.decideWrite(grantFor('read-write'), 'remark'),
      req('req-5'),
      userId,
      at,
    );
    return {};
  },
  changePurposeWrongEnterprise() {
    const { userId, at, req } = CTX();
    const inv = makeInvoice({ enterpriseId: 'C002' });
    inv.changePurpose(
      '采购',
      D.decideWrite(grantFor('read-write', 'C001'), 'purpose'),
      req('req-6'),
      userId,
      at,
    );
    return {};
  },
  changePurposeSameValue() {
    const { userId, at, req } = CTX();
    const inv = makeInvoice({ purpose: '采购' });
    const out = inv.changePurpose(
      '采购',
      D.decideWrite(grantFor('read-write'), 'purpose'),
      req('req-7'),
      userId,
      at,
    );
    return { status: out.status, version: inv.version };
  },
  changePurposeReplaySame() {
    const { userId, at, req } = CTX();
    const inv = makeInvoice();
    const dec = D.decideWrite(grantFor('read-write'), 'purpose');
    inv.changePurpose('采购', dec, req('req-8'), userId, at);
    const out = inv.changePurpose('采购', dec, req('req-8'), userId, at);
    return { status: out.status };
  },
  changePurposeReplayConflict() {
    const { userId, at, req } = CTX();
    const inv = makeInvoice();
    const dec = D.decideWrite(grantFor('read-write'), 'purpose');
    inv.changePurpose('采购', dec, req('req-9'), userId, at);
    inv.changePurpose('差旅', dec, req('req-9'), userId, at);
    return {};
  },
  snapshotImmutable() {
    const inv = makeInvoice({ purpose: '采购' });
    const snap = inv.snapshot();
    // 快照是拷贝：改动它不得回写到聚合根
    try {
      snap.purpose = '被篡改';
    } catch {
      // 冻结实现也算通过
    }
    return { value: inv.purpose === '采购' };
  },
  remarkDoesNotCountAsPurpose() {
    const inv = makeInvoice({ purpose: null, remark: '这里写了很多说明' });
    return { value: inv.isPurposeMissing() };
  },
  bothEmpty() {
    const inv = makeInvoice({ purpose: null, remark: null });
    return { value: inv.isPurposeMissing() };
  },
  changeRemarkAllowed() {
    const { userId, at, req } = CTX();
    const inv = makeInvoice({ purpose: null });
    inv.changeRemark(
      '两日住宿',
      D.decideWrite(grantFor('read-write'), 'remark'),
      req('req-10'),
      userId,
      at,
    );
    return { remark: inv.remark, purpose: inv.purpose, version: inv.version };
  },
  remarkTooLong() {
    const { userId, at, req } = CTX();
    const inv = makeInvoice();
    inv.changeRemark(
      '注'.repeat(501),
      D.decideWrite(grantFor('read-write'), 'remark'),
      req('req-11'),
      userId,
      at,
    );
    return {};
  },
  remarkBlank() {
    const { userId, at, req } = CTX();
    const inv = makeInvoice({ remark: '原备注' });
    inv.changeRemark(
      '  ',
      D.decideWrite(grantFor('read-write'), 'remark'),
      req('req-12'),
      userId,
      at,
    );
    return { remark: inv.remark };
  },
  remarkCannotChangePurpose() {
    const { userId, at, req } = CTX();
    const inv = makeInvoice({ purpose: '原用途' });
    inv.changeRemark(
      '新备注',
      D.decideWrite(grantFor('read-write'), 'remark'),
      req('req-13'),
      userId,
      at,
    );
    return { purpose: inv.purpose, version: inv.version };
  },

  /* ACL */
  aclU001C001Purpose() {
    const d = D.decideWrite(grantFor('read-write', 'C001'), 'purpose');
    return { allowed: d.allowed, field: d.allowed ? d.field : undefined };
  },
  aclU001C002Remark() {
    const d = D.decideWrite(grantFor('read-write', 'C002'), 'remark');
    return { allowed: d.allowed, field: d.allowed ? d.field : undefined };
  },
  aclU002C001Read() {
    return { allowed: D.decideRead(grantFor('read-only', 'C001')).allowed };
  },
  aclU002C001Write() {
    const d = D.decideWrite(grantFor('read-only', 'C001'), 'purpose');
    return { allowed: d.allowed, reason: d.allowed ? undefined : d.reason };
  },
  aclU002C002Read() {
    const d = D.decideRead(grantFor('none', 'C002'));
    return { allowed: d.allowed, reason: d.allowed ? undefined : d.reason };
  },
  aclNullGrant() {
    const d = D.decideRead(null);
    return { allowed: d.allowed, reason: d.allowed ? undefined : d.reason };
  },

  /* Rules */
  rulesC001Sept: () => ({ selected: ids(select('C001', '2026-09')) }),
  rulesC001SeptRejected: () => ({ rejectedHas: rejectedKeys(select('C001', '2026-09')) }),
  rulesC002Sept: () => ({ selected: ids(select('C002', '2026-09')) }),
  rulesC001Aug: () => ({ selected: ids(select('C001', '2026-08')) }),
  rulesC001July: () => ({ selected: ids(select('C001', '2026-07')) }),
  rulesEmpty() {
    const sel = D.selectApplicableRules({
      candidates: [],
      scope: D.enterpriseId('C001'),
      asOfMonth: D.parseMonth('2026-09'),
      at: D.parseIsoDate('2026-09-10'),
    });
    return { selected: ids(sel) };
  },
  rulesAmbiguous() {
    select('C001', '2026-09', (r) =>
      r.code === 'R002' ? { ...r, effectiveFrom: '2026-08-01', status: 'enabled' } : r,
    );
    return {};
  },
  rulesC001SeptV1Enabled: () => ({
    selected: ids(
      select('C001', '2026-09', (r) =>
        r.code === 'R002' && r.version === '1.0' ? { ...r, status: 'enabled' } : r,
      ),
    ),
  }),
  citationShape() {
    const car = select('C001', '2026-09').selected[0];
    return {
      value: car !== undefined && typeof car.code === 'string' && typeof car.version === 'string',
    };
  },

  /* Purpose audit */
  auditAlwaysBlank({ obligation, amount, purpose }) {
    const inv = makeInvoice({ amount, purpose });
    const ob = obligation === 'all' ? D.PURPOSE_REQUIRED_ALL : D.atLeast('1000.00');
    return { verdict: D.auditPurpose(inv, ob) };
  },
  auditThreshold({ obligation, amount, purpose }) {
    const inv = makeInvoice({ amount, purpose });
    return { verdict: D.auditPurpose(inv, D.atLeast(fmtCents(BigInt(obligation)))) };
  },
  compliantPair() {
    return { value: D.isCompliant('present') && D.isCompliant('allowed-empty') };
  },

  /* Month summary */
  summaryInvoicesC001Sept() {
    const invs = [
      makeInvoice({ amount: '500.00', issuedOn: '2026-09-01', invoiceNo: 'F001' }),
      makeInvoice({ amount: '9122.06', issuedOn: '2026-09-30', invoiceNo: 'F010' }),
      // 混入 8 月与另一企业，必须被过滤掉
      makeInvoice({ amount: '9999.99', issuedOn: '2026-08-31', invoiceNo: 'F011' }),
      makeInvoice({
        amount: '9999.99',
        issuedOn: '2026-09-15',
        invoiceNo: 'F001',
        enterpriseId: 'C002',
      }),
    ];
    const s = D.summarizeInvoices(D.enterpriseId('C001'), D.parseMonth('2026-09'), invs);
    return {
      total: s.totalInclTax.format({ grouped: false }),
      count: s.invoiceCount,
      outcome: s.outcome,
    };
  },
  summaryInvoicesEmpty() {
    const s = D.summarizeInvoices(D.enterpriseId('C001'), D.parseMonth('2026-07'), []);
    return {
      total: s.totalInclTax.format({ grouped: false }),
      count: s.invoiceCount,
      outcome: s.outcome,
    };
  },
  summaryBankC001Sept() {
    const mk = (no, date, dir, amt) =>
      D.BankTransaction.rehydrate({
        id: D.bankTransactionId('C001', no),
        occurredOn: D.parseIsoDate(date),
        direction: dir,
        amount: D.Money.parse(amt),
        counterpartyName: '对方（模拟）',
        remark: null,
      });
    const s = D.summarizeBank(D.enterpriseId('C001'), D.parseMonth('2026-09'), [
      mk('T001', '2026-09-01', 'expense', '400.00'),
      mk('T002', '2026-09-03', 'expense', '6780.74'),
      mk('T009', '2026-09-04', 'income', '3000.00'),
      mk('T010', '2026-09-14', 'income', '10000.50'),
    ]);
    return {
      expense: s.expenseTotal.format({ grouped: false }),
      income: s.incomeTotal.format({ grouped: false }),
    };
  },
  summaryBankExpenseOnly() {
    const mk = (no, amt) =>
      D.BankTransaction.rehydrate({
        id: D.bankTransactionId('C001', no),
        occurredOn: D.parseIsoDate('2026-09-01'),
        direction: 'expense',
        amount: D.Money.parse(amt),
        counterpartyName: '对方（模拟）',
        remark: null,
      });
    const s = D.summarizeBank(D.enterpriseId('C001'), D.parseMonth('2026-09'), [
      mk('T001', '500.00'),
    ]);
    return {
      expense: s.expenseTotal.format({ grouped: false }),
      income: s.incomeTotal.format({ grouped: false }),
    };
  },
  summaryBankNoNet() {
    const s = D.summarizeBank(D.enterpriseId('C001'), D.parseMonth('2026-09'), []);
    return { value: !('net' in s) && !('netTotal' in s) };
  },

  /* TaskCard */
  taskCardDisjoint() {
    const { userId, at } = CTX();
    const scope = D.memoryScope(userId, D.enterpriseId('C001'));
    const ref = D.invoiceRefParts(D.enterpriseId('C001'), D.invoiceNo('F002'));
    const { card } = D.TaskCard.open(scope, D.parseMonth('2026-09'), [ref], at);
    card.markCompleted(
      ref,
      {
        invoiceId: D.InvoiceId.of(D.enterpriseId('C001'), D.invoiceNo('F002')),
        field: 'purpose',
        requestId: D.parseRequestId('req-x'),
        verifiedAt: at,
        observedVersion: 2,
      },
      at,
    );
    const snap = card.toSnapshot();
    const pendingKeys = snap.pending.map((i) => i.ref.invoiceNo);
    const doneKeys = snap.completed.map((i) => i.ref.invoiceNo);
    return { value: pendingKeys.every((k) => !doneKeys.includes(k)) };
  },
  taskCardRequiresVerifiedWrite() {
    const { userId, at } = CTX();
    const scope = D.memoryScope(userId, D.enterpriseId('C001'));
    const ref = D.invoiceRefParts(D.enterpriseId('C001'), D.invoiceNo('F002'));
    const { card } = D.TaskCard.open(scope, D.parseMonth('2026-09'), [ref], at);
    // 未在待办中的发票不得标记完成
    card.markCompleted(
      D.invoiceRefParts(D.enterpriseId('C001'), D.invoiceNo('F009')),
      {
        invoiceId: D.InvoiceId.of(D.enterpriseId('C001'), D.invoiceNo('F009')),
        field: 'purpose',
        requestId: D.parseRequestId('req-y'),
        verifiedAt: at,
        observedVersion: 2,
      },
      at,
    );
    return {};
  },
  taskCardSingleActive() {
    const { userId, at } = CTX();
    const scope = D.memoryScope(userId, D.enterpriseId('C001'));
    const ref = D.invoiceRefParts(D.enterpriseId('C001'), D.invoiceNo('F002'));
    const first = D.TaskCard.open(scope, D.parseMonth('2026-09'), [ref], at);
    const second = D.TaskCard.open(scope, D.parseMonth('2026-09'), [ref], at);
    // 领域层只保证同一 scope+month 得到同一 ID；
    // 「至多一个 open」由仓储唯一索引 uq_task_card_active 强制（L3 覆盖）。
    // 这里断言 ID 稳定性，作为该唯一索引能够生效的前提。
    return { value: second.card.id.value === first.card.id.value };
  },
};
