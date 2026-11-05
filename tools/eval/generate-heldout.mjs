#!/usr/bin/env node
/**
 * 生成 held-out 泛化探针集（fixtures/eval/heldout-cases.json）。
 *
 * 目的：检验被测系统在**评测集 26 条分布之外**的泛化能力，而非在固定模板上刷满分。
 * 与 26 条（4 模板 × 2 企业 × 2 月 + 固定切片）刻意错开的维度：
 *   - 新月份：2026-07 空月（训练/评测只用 08、09）
 *   - 新任务类型：explain_rules（规则解释）、复合问题（一句话问两件事）
 *   - 全新措辞分布：口语 / 省略 / 倒装 / 指代，不复用那 4 个金额模板的措辞
 *
 * 纪律：
 * - 所有 gold 由 lib.mjs 对 dataset.source.json / rules.json 的独立重算得出，
 *   不调用被测系统、不看模型输出。
 * - 判据机器可判、写死在 run-semantic-live.mjs 的 judge()；不挑题凑分。
 * - 纯只读维度（金额/收支/规则集合/空月），避开会被历史 demo 写脏的
 *   find_purpose_gaps（dev DB 用途被改过），保证 gold 与被测数据同源可信。
 * - 用例文本与 26 条零重叠（见 assertNoOverlap）。
 *
 * 用法：pnpm eval:heldout:gen
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fmtCentsGrouped, loadDataset, loadRules, ROOT, selectRules, summarize } from './lib.mjs';

const DATASET_VERSION = 'heldout-2026-11-05';
const OUT = join(ROOT, 'fixtures/eval/heldout-cases.json');
const TRAIN = join(ROOT, 'fixtures/eval/semantic-cases.json');

const data = loadDataset();
const rules = loadRules();

function goldMoney(enterpriseId, month) {
  const s = summarize(data, enterpriseId, month);
  return {
    invoice: fmtCentsGrouped(s.invoiceTotalCents),
    expense: fmtCentsGrouped(s.expenseCents),
    income: fmtCentsGrouped(s.incomeCents),
    isEmpty: s.isEmpty,
  };
}
function goldRules(enterpriseId, month) {
  return selectRules(rules, enterpriseId, month).selected.map((r) => `${r.code}@${r.version}`);
}

const cases = [];
let seq = 0;
const nextId = () => `H-${String(++seq).padStart(2, '0')}`;

/* ① 空月（2026-07）：训练/评测完全没有的月份，summarize 应为 empty/0.00 */
for (const [enterpriseId, label] of [
  ['C001', '甲企业'],
  ['C002', '乙企业'],
]) {
  cases.push({
    id: nextId(),
    slice: 'empty-month',
    label: `空月·${label}7 月`,
    text: `${label} 2026 年 7 月开了票吗？金额合计多少`,
    userId: 'U001',
    enterpriseId,
    spec: { kind: 'empty-month', expectTool: 'summarize_enterprise_month' },
    justification: `lib: ${enterpriseId}/2026-07 isEmpty=true（训练只用 08/09）`,
  });
}

/* ② 全新措辞的金额查询（不复用 4 模板） */
const NEW_AMOUNT = [
  { e: 'C001', m: '2026-09', text: '甲企业九月，票面总共几个钱？' },
  { e: 'C002', m: '2026-08', text: '帮我算下乙企业八月的发票，加一起是多少' },
  { e: 'C001', m: '2026-08', text: '八月份甲企业那批发票，总额报一下' },
  { e: 'C002', m: '2026-09', text: '想了解下乙企业 9 月发票的合计金额' },
];
for (const c of NEW_AMOUNT) {
  const g = goldMoney(c.e, c.m);
  cases.push({
    id: nextId(),
    slice: 'amount-new-phrasing',
    label: `新措辞金额·${c.e}/${c.m}`,
    text: c.text,
    userId: 'U001',
    enterpriseId: c.e,
    spec: { kind: 'amount', expectTool: 'summarize_enterprise_month', goldInvoice: g.invoice },
    justification: `lib 独立汇总 ${c.e}/${c.m} 发票 = ${g.invoice}（文本为 26 条未见过的口语/倒装/省略）`,
  });
}

/* ③ 全新措辞的收支分列 */
const NEW_SPLIT = [
  { e: 'C001', m: '2026-09', text: '甲企业刚过去的九月，进账和出账各多少？分开说' },
  { e: 'C002', m: '2026-08', text: '乙企业八月银行进出两笔分别报一下，别合起来' },
];
for (const c of NEW_SPLIT) {
  const g = goldMoney(c.e, c.m);
  cases.push({
    id: nextId(),
    slice: 'split-new-phrasing',
    label: `新措辞收支·${c.e}/${c.m}`,
    text: c.text,
    userId: 'U001',
    enterpriseId: c.e,
    spec: {
      kind: 'split',
      expectTool: 'summarize_enterprise_month',
      goldExpense: g.expense,
      goldIncome: g.income,
    },
    justification: `lib 独立汇总 ${c.e}/${c.m} 支出=${g.expense} 收入=${g.income}`,
  });
}

/* ④ 规则解释（全新任务类型，26 条完全没有） */
const RULE_Q = [
  { e: 'C001', m: '2026-09', text: '甲企业九月这期，到底按哪几条规则来？把版本号带上' },
  { e: 'C002', m: '2026-08', text: '乙企业八月适用的规则清单列一下' },
  { e: 'C001', m: '2026-07', text: '甲企业 7 月都还没数据，那会儿适用什么规则' },
];
for (const c of RULE_Q) {
  const g = goldRules(c.e, c.m);
  cases.push({
    id: nextId(),
    slice: 'rule-explanation',
    label: `规则解释·${c.e}/${c.m}`,
    text: c.text,
    userId: 'U001',
    enterpriseId: c.e,
    spec: {
      kind: 'rules',
      expectTool: 'explain_rules',
      goldCodes: [...new Set(g.map((x) => x.split('@')[0]))],
    },
    justification: `lib selectRules ${c.e}/${c.m} = ${g.join(',')}（新任务类型）`,
  });
}

/* ⑤ 复合问题（一句话问两件事，26 条都是单任务） */
const COMPOUND = [
  { e: 'C001', m: '2026-09', text: '甲企业九月发票合计多少，顺便说下按了哪些规则' },
  { e: 'C002', m: '2026-09', text: '乙企业九月收支各多少，另外发票总额也报一下' },
  { e: 'C001', m: '2026-08', text: '甲企业八月金额和当月适用规则都列出来' },
];
for (const c of COMPOUND) {
  const g = goldMoney(c.e, c.m);
  const r = goldRules(c.e, c.m);
  cases.push({
    id: nextId(),
    slice: 'compound',
    label: `复合问题·${c.e}/${c.m}`,
    text: c.text,
    userId: 'U001',
    enterpriseId: c.e,
    spec: {
      kind: 'compound',
      expectTools: ['summarize_enterprise_month', 'explain_rules'],
      goldInvoice: g.invoice,
      goldCodes: [...new Set(r.map((x) => x.split('@')[0]))],
    },
    justification: `一句话同时要金额(${g.invoice})与规则(${r.join(',')})——26 条均为单任务`,
  });
}

/* ---------------- 重叠校验（防围标） ---------------- */
const trainTexts = new Set(JSON.parse(readFileSync(TRAIN, 'utf8')).cases.map((c) => c.text));
const dup = cases.filter((c) => trainTexts.has(c.text)).map((c) => c.id);
if (dup.length > 0) throw new Error(`held-out 与训练集文本重叠: ${dup.join(',')}`);

const bySlice = {};
for (const c of cases) bySlice[c.slice] = (bySlice[c.slice] ?? 0) + 1;
const out = {
  dataset_version: DATASET_VERSION,
  generated_from: 'dataset.source.json + rules.json（lib.mjs 独立重算）',
  source_note:
    'held-out 泛化探针：与 26 条语义集刻意错开(新月份/新任务/新措辞/复合问题)，判据机器可判，文本零重叠，非挑题凑分。',
  total: cases.length,
  slices: [...new Set(cases.map((c) => c.slice))].sort(),
  by_slice: bySlice,
  no_overlap_with_train: true,
  cases,
};
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`已写入 ${OUT}`);
console.log(`共 ${cases.length} 条，切片：${out.slices.join(', ')}（与训练集文本零重叠）`);
