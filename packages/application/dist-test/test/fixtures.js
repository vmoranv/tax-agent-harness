/**
 * 测试夹具：从赛题 Excel 抽出的小样本，金额与官方核对表一致。
 *
 * 只保留判分相关的发票：
 * - C001/2026-09：5 张空用途（全量必填规则下全部 missing）
 * - C002/2026-09：6 张空用途，但只有 3 张 missing（≥1000 门槛）
 * - 边界：F002=1000.00（必须填）、F004=999.99（可空）、F008=600.00 已填（present）
 */
import { accessGrant, atLeast, BankTransaction, bankTransactionId, Enterprise as EnterpriseClass, enterpriseId, Invoice, invoiceNo, Money, PURPOSE_REQUIRED_ALL, parseIsoDate, RuleDocument, ruleCode, ruleVersion, UserAccount as UserAccountClass, userId, } from '@harness/domain';
import { InMemoryUnitOfWork } from './fakes/in-memory.js';
const U1 = userId('U001');
const U2 = userId('U002');
const C1 = enterpriseId('C001');
const C2 = enterpriseId('C002');
const T0 = parseIsoDate('2026-09-01');
export const IDS = { U1, U2, C1, C2 };
const C001_SEP = [
    { ent: C1, no: 'F001', day: '2026-09-01', amount: '500.00', purpose: '购买办公文具' },
    { ent: C1, no: 'F002', day: '2026-09-08', amount: '800.00', purpose: null },
    { ent: C1, no: 'F003', day: '2026-09-16', amount: '300.00', purpose: null },
    { ent: C1, no: 'F004', day: '2026-09-10', amount: '999.99', purpose: null },
    { ent: C1, no: 'F005', day: '2026-09-12', amount: '1000.00', purpose: '办公场地清洁' },
    { ent: C1, no: 'F006', day: '2026-09-20', amount: '1000.01', purpose: null },
    { ent: C1, no: 'F007', day: '2026-09-24', amount: '1280.50', purpose: '客户演示场地租用' },
    { ent: C1, no: 'F008', day: '2026-09-28', amount: '2560.88', purpose: '员工出差住宿' },
    { ent: C1, no: 'F009', day: '2026-09-29', amount: '680.68', purpose: null },
    { ent: C1, no: 'F010', day: '2026-09-30', amount: '500.00', purpose: '日常文件打印' },
];
const C002_SEP = [
    { ent: C2, no: 'F001', day: '2026-09-01', amount: '600.00', purpose: null },
    { ent: C2, no: 'F002', day: '2026-09-08', amount: '1000.00', purpose: null },
    { ent: C2, no: 'F003', day: '2026-09-16', amount: '1500.00', purpose: '购买展示用品' },
    { ent: C2, no: 'F004', day: '2026-09-10', amount: '999.99', purpose: null },
    { ent: C2, no: 'F005', day: '2026-09-12', amount: '1000.01', purpose: null },
    { ent: C2, no: 'F006', day: '2026-09-20', amount: '1280.50', purpose: null },
    { ent: C2, no: 'F007', day: '2026-09-24', amount: '3200.00', purpose: '客户交流会议场地' },
    { ent: C2, no: 'F008', day: '2026-09-28', amount: '600.00', purpose: '会议资料邮寄' },
    { ent: C2, no: 'F009', day: '2026-09-29', amount: '486.75', purpose: null },
    { ent: C2, no: 'F010', day: '2026-09-30', amount: '1999.99', purpose: '设备例行维护' },
];
const BANK_SEP = [
    { ent: 'C001', no: 'T001', day: '2026-09-01', dir: 'expense', cents: 40000n },
    { ent: 'C001', no: 'T002', day: '2026-09-03', dir: 'expense', cents: 50000n },
    { ent: 'C001', no: 'T009', day: '2026-09-04', dir: 'income', cents: 300000n },
    { ent: 'C001', no: 'T003', day: '2026-09-05', dir: 'expense', cents: 30000n },
    { ent: 'C001', no: 'T004', day: '2026-09-08', dir: 'expense', cents: 80025n },
    { ent: 'C001', no: 'T005', day: '2026-09-12', dir: 'expense', cents: 100000n },
    { ent: 'C001', no: 'T010', day: '2026-09-14', dir: 'income', cents: 520050n },
    { ent: 'C001', no: 'T006', day: '2026-09-17', dir: 'expense', cents: 99999n },
    { ent: 'C001', no: 'T007', day: '2026-09-22', dir: 'expense', cents: 50000n },
    { ent: 'C001', no: 'T011', day: '2026-09-25', dir: 'income', cents: 180000n },
    { ent: 'C001', no: 'T008', day: '2026-09-30', dir: 'expense', cents: 268050n },
    { ent: 'C001', no: 'T012', day: '2026-09-30', dir: 'income', cents: 300000n },
    { ent: 'C002', no: 'T001', day: '2026-09-01', dir: 'expense', cents: 100000n },
    { ent: 'C002', no: 'T002', day: '2026-09-03', dir: 'expense', cents: 60000n },
    { ent: 'C002', no: 'T009', day: '2026-09-04', dir: 'income', cents: 450000n },
    { ent: 'C002', no: 'T003', day: '2026-09-05', dir: 'expense', cents: 40000n },
    { ent: 'C002', no: 'T004', day: '2026-09-08', dir: 'expense', cents: 100000n },
    { ent: 'C002', no: 'T005', day: '2026-09-12', dir: 'expense', cents: 150050n },
    { ent: 'C002', no: 'T010', day: '2026-09-14', dir: 'income', cents: 320000n },
    { ent: 'C002', no: 'T006', day: '2026-09-17', dir: 'expense', cents: 99999n },
    { ent: 'C002', no: 'T007', day: '2026-09-22', dir: 'expense', cents: 48675n },
    { ent: 'C002', no: 'T011', day: '2026-09-25', dir: 'income', cents: 150075n },
    { ent: 'C002', no: 'T008', day: '2026-09-30', dir: 'expense', cents: 210000n },
    { ent: 'C002', no: 'T012', day: '2026-09-30', dir: 'income', cents: 450000n },
];
function buildBank(spec) {
    return BankTransaction.rehydrate({
        id: bankTransactionId(spec.ent, spec.no),
        occurredOn: parseIsoDate(spec.day),
        direction: spec.dir,
        amount: Money.fromCents(spec.cents),
        counterpartyName: '对方（模拟）',
        remark: null,
    });
}
export function bankRows() {
    return BANK_SEP.map(buildBank);
}
function buildInvoice(spec) {
    return Invoice.create({
        enterpriseId: spec.ent,
        invoiceNo: invoiceNo(spec.no),
        issuedOn: parseIsoDate(spec.day),
        sellerName: spec.seller ?? '青禾办公用品（模拟）',
        itemName: spec.item ?? '办公用品',
        amount: Money.parse(spec.amount),
        purpose: spec.purpose,
        remark: null,
        updatedAt: T0,
        updatedBy: U1,
    });
}
export function c001Invoices() {
    return C001_SEP.map(buildInvoice);
}
export function c002Invoices() {
    return C002_SEP.map(buildInvoice);
}
/* ------------------------------ 规则构造 ------------------------------ */
export function rules() {
    const base = {
        category: 'purpose-requirement',
        body: '规则正文（测试夹具）',
        supersedes: null,
        updatedAt: T0,
    };
    const amountRule = RuleDocument.draft({
        ...base,
        code: ruleCode('R001'),
        version: ruleVersion('1.0'),
        title: '金额统计说明',
        category: 'amount-guidance',
        scope: { kind: 'global' },
        effectiveFrom: parseIsoDate('2026-01-01'),
        obligation: null,
    });
    const r002v1 = RuleDocument.draft({
        ...base,
        code: ruleCode('R002'),
        version: ruleVersion('1.0'),
        title: '甲企业发票用途规则',
        scope: { kind: 'enterprise', enterpriseId: C1 },
        effectiveFrom: parseIsoDate('2026-08-01'),
        obligation: atLeast('1000.00'),
    });
    r002v1.disable(parseIsoDate('2026-08-15'), '被 v2.0 取代');
    const r002v2 = RuleDocument.draft({
        ...base,
        code: ruleCode('R002'),
        version: ruleVersion('2.0'),
        title: '甲企业发票用途规则',
        scope: { kind: 'enterprise', enterpriseId: C1 },
        effectiveFrom: parseIsoDate('2026-09-01'),
        obligation: PURPOSE_REQUIRED_ALL,
    });
    const r003 = RuleDocument.draft({
        ...base,
        code: ruleCode('R003'),
        version: ruleVersion('1.0'),
        title: '乙企业发票用途规则',
        scope: { kind: 'enterprise', enterpriseId: C2 },
        effectiveFrom: parseIsoDate('2026-08-01'),
        obligation: atLeast('1000.00'),
    });
    const r004 = RuleDocument.draft({
        ...base,
        code: ruleCode('R004'),
        version: ruleVersion('1.0'),
        title: '银行资料说明',
        category: 'bank-guidance',
        scope: { kind: 'global' },
        effectiveFrom: parseIsoDate('2026-01-01'),
        obligation: null,
    });
    return [amountRule, r002v1, r002v2, r003, r004];
}
/* ------------------------------ 主体构造 ------------------------------ */
function enterprise(id, legal, alias) {
    return EnterpriseClass.register(id, legal, [alias]);
}
/** 装配一个完整的内存世界。 */
export function makeWorld() {
    const uow = new InMemoryUnitOfWork();
    uow.enterprises.seed([
        enterprise(C1, '甲企业（比赛模拟）', '甲企业'),
        enterprise(C2, '乙企业（比赛模拟）', '乙企业'),
    ]);
    uow.users.seed([
        UserAccountClass.register(U1, '测试用户一', T0),
        UserAccountClass.register(U2, '测试用户二', T0),
    ]);
    uow.grants.seed([
        {
            userId: U1,
            grant: accessGrant({
                enterpriseId: C1,
                level: 'read-write',
                grantedAt: T0,
                grantedBy: 'system',
            }),
        },
        {
            userId: U1,
            grant: accessGrant({
                enterpriseId: C2,
                level: 'read-write',
                grantedAt: T0,
                grantedBy: 'system',
            }),
        },
        {
            userId: U2,
            grant: accessGrant({
                enterpriseId: C1,
                level: 'read-only',
                grantedAt: T0,
                grantedBy: 'system',
            }),
        },
        {
            userId: U2,
            grant: accessGrant({
                enterpriseId: C2,
                level: 'none',
                grantedAt: T0,
                grantedBy: 'system',
            }),
        },
    ]);
    uow.invoices.seed([...c001Invoices(), ...c002Invoices()]);
    uow.banks.seed(bankRows());
    uow.rules.seed(rules());
    return { uow, u1: U1, u2: U2, c1: C1, c2: C2 };
}
//# sourceMappingURL=fixtures.js.map