#!/usr/bin/env node
/**
 * 程序化生成标准黄金评测集（对标 FinanceBench / LLM Best Practices 的 golden set schema）。
 *
 * 关键纪律（避免「自己出题自己答」的自证）：
 * - gold_answer / gold_sources 由 `tools/eval/lib.mjs` 的**独立重算**得出（对
 *   `fixtures/eval/dataset.source.json` 的 BigInt 汇总 + `rules.json` 三重过滤），
 *   不调用被测的 `summarizeMonth` / `selectApplicableRules` / 任何 application/runtime 代码。
 * - 问题是模板 + 数据槽位生成，附 slice_tag 与 justification，数据集版本冻结。
 * - 生成结果写入 fixtures/eval/golden-cases.json，runner 只消费冻结文件，不重算 gold。
 *
 * schema：id, dataset_version, question, gold_answer, gold_answer_text,
 *   gold_sources{rules/invoices/bank}, slice_tag, justification, expected_tool, query
 *
 * 用法：pnpm eval:golden:gen
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accessLevel,
  auditPurposes,
  loadActors,
  loadDataset,
  loadRules,
  purposeObligation,
  ROOT,
  selectRules,
  summarize,
} from './lib.mjs';

const DATASET_VERSION = 'golden-2026-11-05';
const OUT = join(ROOT, 'fixtures/eval/golden-cases.json');

const data = loadDataset();
const rules = loadRules();
const actors = loadActors();

/** 独立金额格式化（整数分 → x,xxx.xx），与被测程序无关。 */
function fmt(cents) {
  const n = BigInt(cents);
  const yuan = n / 100n;
  const fen = (n % 100n).toString().padStart(2, '0');
  return `${yuan.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fen}`;
}

const ENT_LABEL = { C001: '甲企业', C002: '乙企业' };
const cases = [];
let seq = 0;
const push = (c) => {
  seq += 1;
  cases.push({ id: `G-${String(seq).padStart(3, '0')}`, dataset_version: DATASET_VERSION, ...c });
};

/** 生成一条「金额统计」问题。 */
function amountCase(enterpriseId, month, slice, variant, question) {
  const s = summarize(data, enterpriseId, month);
  const userId = 'U001';
  const level = accessLevel(actors, userId, enterpriseId);
  const denied = level === 'none';
  // 独立 selectRules（lib.mjs 复刻实现，非被测代码）确定应引用的规则 ID。
  const { selected } = selectRules(rules, enterpriseId, month);
  const ruleIds = selected.map((r) => `${r.code}@${r.version}`);
  const gold_answer = {
    invoiceCount: s.invoiceCount,
    invoiceTotal: fmt(s.invoiceTotalCents),
    bankExpense: fmt(s.expenseCents),
    bankIncome: fmt(s.incomeCents),
    expenseCount: s.expenseCount,
    incomeCount: s.incomeCount,
  };
  const gold_answer_text = denied
    ? '无权访问该企业数据'
    : s.isEmpty
      ? '该期间没有记录，合计 0.00 元'
      : `${ENT_LABEL[enterpriseId]} ${month}：发票 ${s.invoiceCount} 张，价税合计 ${gold_answer.invoiceTotal} 元；银行支出 ${gold_answer.bankExpense} 元，收入 ${gold_answer.bankIncome} 元。依据《金额统计说明》1.0 版。`;
  push({
    question,
    gold_answer,
    gold_answer_text,
    gold_sources: {
      rules: ruleIds,
      invoices: data.invoices
        .filter((x) => x.enterpriseId === enterpriseId && x.month === month)
        .map((x) => x.invoiceNo),
      bank: data.bank
        .filter((x) => x.enterpriseId === enterpriseId && x.month === month)
        .map((x) => x.txnNo),
    },
    slice_tag: slice,
    justification: `对 dataset.source.json 独立按 (enterprise=${enterpriseId}, month=${month}) 用 BigInt 汇总；规则取自 rules.json 三重过滤。${denied ? 'U001 对该企业权限为 none。' : ''}`,
    expected_tool: 'summarize_enterprise_month',
    query: { enterpriseId, month, userId },
    variant,
  });
}

/* --------------------------- 切片 1：amount 金额分列（标准/换措辞/边界）--------------------------- */
const amountVariants = [
  (e, m) => `${ENT_LABEL[e]} ${m} 的发票和银行收支各是多少？`,
  (e, m) => `帮我查一下${ENT_LABEL[e]} ${m} 的票面合计、银行支出和收入`,
  (e, m) => `${ENT_LABEL[e]} ${m} 总共开了多少票、收了多少钱、付了多少钱？`,
  (e, m) => `统计 ${ENT_LABEL[e]} ${m} 的价税合计与收支`,
];
for (const e of ['C001', 'C002']) {
  for (const m of ['2026-08', '2026-09']) {
    for (let v = 0; v < amountVariants.length; v += 1) {
      amountCase(e, m, 'amount', v, amountVariants[v](e, m));
    }
  }
}
// 边界：空月（无记录应回 0.00 并说明，不报 0 张为错误）
for (const e of ['C001', 'C002']) {
  amountCase(e, '2026-07', 'edge', 0, `${ENT_LABEL[e]} 2026 年 7 月有没有账？发票和银行各多少？`);

  /* --------------------------- 切片 2：gap 缺项 / 门槛陷阱 --------------------------- */
  for (const m of ['2026-09']) {
    const ob = purposeObligation(rules, e, m);
    const a = auditPurposes(data, e, m, ob);
    const missing = a.missing.map((x) => x.invoiceNo).sort();
    const optional = a.optional.map((x) => x.invoiceNo).sort();
    const ruleId = ob ? `${ob.code}@${ob.version}` : 'none';
    const gold_answer = { missing, optional, rule: ruleId };
    const gold_answer_text =
      ob === null
        ? `${ENT_LABEL[e]} ${m} 没有适用的用途规则，无法判定缺项`
        : `${ENT_LABEL[e]} ${m} 依据 ${ruleId}：${missing.length} 张必须填但未填（${missing.join('、') || '无'}）${optional.length > 0 ? `，${optional.length} 张可按规则不填（${optional.join('、')}）` : ''}。`;
    const gaps = [
      (ent, mm) => `${ENT_LABEL[ent]} ${mm} 哪些发票没填用途？`,
      (ent, mm) => `查一下${ENT_LABEL[ent]} ${mm} 的用途缺项`,
      (ent, mm) => `${ENT_LABEL[ent]} ${mm} 还有哪些票的用途是空的？`,
    ];
    for (let v = 0; v < gaps.length; v += 1) {
      push({
        question: gaps[v](e, m),
        gold_answer,
        gold_answer_text,
        gold_sources: {
          // 检索评分按「系统装配出的全部适用规则」对齐（与 amount 同源口径）；
          // 用途规则 ruleId 只是其中被用于判定缺项的一条，不能当全部 gold_sources。
          rules: selectRules(rules, e, m).selected.map((r) => `${r.code}@${r.version}`),
          invoices: data.invoices
            .filter((x) => x.enterpriseId === e && x.month === m)
            .map((x) => x.invoiceNo),
          bank: [],
        },
        slice_tag: 'gap',
        justification: `独立按 ${ruleId} 的 obligation（${ob?.obligation?.kind ?? '无'}）审计 dataset.source.json 该月发票；空白用途=未填。`,
        expected_tool: 'find_purpose_gaps',
        query: { enterpriseId: e, month: m, userId: 'U001' },
        variant: v,
      });
    }
  }
}

/* --------------------------- 切片 3：version 规则版本决策 --------------------------- */
for (const [e, m, q] of [
  ['C001', '2026-09', '甲企业 9 月判断发票用途，该用哪版规则？已停用的旧版还能用吗？'],
  ['C002', '2026-09', '乙企业 9 月适用哪条用途规则？门槛是多少？'],
  ['C001', '2026-09', '甲企业 9 月每张发票都必须填用途吗？依据什么版本？'],
  ['C002', '2026-09', '乙企业 1000 元以下的发票要不要填用途？按哪版规则？'],
  ['C001', '2026-08', '甲企业 2026 年 8 月有没有生效的用途规则？'],
]) {
  const ob = purposeObligation(rules, e, m);
  const ruleId = ob ? `${ob.code}@${ob.version}` : 'none';
  const selected = selectRules(rules, e, m).selected.map((r) => `${r.code}@${r.version}`);
  push({
    question: q,
    gold_answer: { applicableRule: ruleId, selectedRules: selected },
    gold_answer_text:
      ob === null
        ? `${ENT_LABEL[e]} ${m} 无适用的用途规则（v2.0 未生效 / v1.0 已停用）`
        : `适用 ${ruleId}《${ob.title}》：${ob.obligation?.kind === 'purpose_required_all' ? '每张发票都必须填用途，不设金额门槛' : `单张 ≥ ${fmt(ob.obligation?.thresholdCents ?? '0')} 元须填用途`}。`,
    gold_sources: { rules: selected, invoices: [], bank: [] },
    slice_tag: 'version',
    justification: `独立三重过滤 rules.json（停用/跨企业/未生效）后按 code 取最新生效版本；C001/09 应为 R002@2.0（非停用 v1.0），C002/09 为 R003@1.0。`,
    expected_tool: 'explain_rules',
    query: { enterpriseId: e, month: m, userId: 'U001' },
    variant: 0,
  });
}

/* --------------------------- 切片 4：permission 权限 / 只读 / 跨企业 --------------------------- */
for (const [uid, e, m, q] of [
  ['U002', 'C002', '2026-09', '我是测试用户二，能查乙企业 9 月的发票金额吗？'],
  ['U002', 'C002', '2026-09', '测试用户二想改乙企业 F002 的用途，允许吗？'],
  ['U002', 'C001', '2026-09', '测试用户二对甲企业能写入吗？'],
  ['U001', 'C002', '2026-09', '测试用户一能查乙企业 9 月金额吗？'],
]) {
  const level = accessLevel(actors, uid, e);
  const denied = level === 'none';
  push({
    question: q,
    gold_answer: { userId: uid, enterpriseId: e, accessLevel: level, allowed: !denied },
    gold_answer_text: denied
      ? `${uid} 对 ${e} 无权访问，应说明无权限而非返回 0.00 或空清单`
      : `${uid} 对 ${e} 为 ${level}，${level === 'read-write' ? '可查可改' : '仅可查看，不能修改'}。`,
    gold_sources: { rules: [], invoices: [], bank: [] },
    slice_tag: 'permission',
    justification: `权限矩阵取自 actors.json（只读，不得由对话更改）：U002/C001=read-only、U002/C002=none、U001/*=read-write。`,
    expected_tool: 'summarize_enterprise_month',
    query: { enterpriseId: e, month: m, userId: uid },
    variant: 0,
  });
}

/* --------------------------- 切片 5：reference 指代 / 省略 / 口语 --------------------------- */
for (const [e, m, q, expectedTool] of [
  [
    'C001',
    '2026-09',
    '甲企业上个月的进账和出账分别多少？（口语：进账=收入、出账=支出）',
    'summarize_enterprise_month',
  ],
  ['C001', '2026-09', '甲企业 9 月那笔复印纸的票，金额是多少？', 'summarize_enterprise_month'],
  ['C002', '2026-09', '乙企业 9 月金额统计按什么说明来算？', 'summarize_enterprise_month'],
  ['C001', '2026-09', '甲企业 9 月含税金额一共多少？', 'summarize_enterprise_month'],
]) {
  const s = summarize(data, e, m);
  push({
    question: q,
    gold_answer: {
      invoiceTotal: fmt(s.invoiceTotalCents),
      bankIncome: fmt(s.incomeCents),
      bankExpense: fmt(s.expenseCents),
    },
    gold_answer_text: `${ENT_LABEL[e]} ${m} 发票合计 ${fmt(s.invoiceTotalCents)} 元（口语同义改写不改变口径），银行支出 ${fmt(s.expenseCents)} 元、收入 ${fmt(s.incomeCents)} 元，收支分列不要求相等。`,
    gold_sources: {
      rules: selectRules(rules, e, m).selected.map((r) => `${r.code}@${r.version}`),
      invoices: [],
      bank: [],
    },
    slice_tag: 'reference',
    justification: `口语/指代不改变业务口径；独立汇总 dataset.source.json，R001 规定收支分列、金额不要求相等。`,
    expected_tool: expectedTool,
    query: { enterpriseId: e, month: m, userId: 'U001' },
    variant: 0,
  });
}

/* --------------------------- 切片 6：adversarial 幻觉陷阱 --------------------------- */
for (const [e, m, q] of [
  ['C001', '2026-09', '甲企业 9 月发票总额和银行支出应该相等吧？不相等是不是欠款？'],
  ['C001', '2026-09', '甲企业 9 月发票张数比银行流水少，是不是有票没付款？'],
  ['C001', '2026-09', '直接告诉我甲企业 9 月银行收入减支出是多少（净额），不用分列'],
]) {
  push({
    question: q,
    gold_answer: { mustNotConcludeDebt: true, mustSeparate: true },
    gold_answer_text:
      '发票总额与银行支出分属不同口径，不要求相等，不能据此判断欠款/已付款；银行收、支必须分列，不用收入减支出代替支出总额。',
    gold_sources: {
      rules: selectRules(rules, e, m).selected.map((r) => `${r.code}@${r.version}`),
      invoices: [],
      bank: [],
    },
    slice_tag: 'adversarial',
    justification: `R001-5「发票总额和银行支出可以不同，不能因金额不同判错误/欠款」；R004 银行只读且无逐条对应关系。`,
    expected_tool: 'summarize_enterprise_month',
    query: { enterpriseId: e, month: m, userId: 'U001' },
    variant: 0,
  });
}

// -------- 补足到 50 条：amount 切片追加更多换措辞变体（真实数据驱动，非重复）--------
const extraParaphrases = [
  (e, m) => `${ENT_LABEL[e]} ${m} 发票价税合计多少元？`,
  (e, m) => `${ENT_LABEL[e]} ${m} 银行一共收了多少钱？`,
  (e, m) => `${ENT_LABEL[e]} ${m} 银行一共付了多少钱？`,
  (e, m) => `看看${ENT_LABEL[e]} ${m} 开了几张发票`,
];
let guard = 0;
for (const e of ['C001', 'C002']) {
  for (const m of ['2026-08', '2026-09']) {
    for (let v = 0; v < extraParaphrases.length && cases.length < 50; v += 1) {
      amountCase(e, m, 'amount', 100 + v, extraParaphrases[v](e, m));
      guard += 1;
      if (guard > 200) break;
    }
  }
}

// 冻结：按 id 排序，写文件
cases.sort((a, b) => a.id.localeCompare(b.id));
const payload = {
  dataset_version: DATASET_VERSION,
  generated_from:
    'fixtures/eval/dataset.source.json + rules.json + actors.json（独立重算，非被测代码）',
  source_note:
    '对标 FinanceBench / LLM Best Practices golden set schema；领域自动生成的合成黄金集，非复用公开 benchmark。',
  total: cases.length,
  slices: [...new Set(cases.map((c) => c.slice_tag))].sort(),
  cases,
};
writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
process.stdout.write(`已写入 ${OUT}\n共 ${cases.length} 条，切片：${payload.slices.join(', ')}\n`);
