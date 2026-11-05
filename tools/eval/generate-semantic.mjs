#!/usr/bin/env node
/**
 * 程序化生成「真模型语义变体」评测集（供 run-semantic-live.mjs 消费）。
 *
 * 纪律（避免自己出题自己答 / 避免挑简单题凑分）：
 * - gold（金额、收支、追问约束）全部由 lib.mjs 对 dataset.source.json 的
 *   独立 BigInt 重算 + actors.json 权限矩阵得出，**不调用被测系统、不看模型输出**。
 * - 每条带机器可判 spec（kind + gold 字段），判据写死在 run-semantic-live.mjs，
 *   不在此处生成"宽松正则"。
 * - 措辞/企业/月份/用户自由组合，覆盖 6 个语义能力切片，不特挑模型答得对的题。
 *
 * 输出：fixtures/eval/semantic-cases.json（冻结、版本化）。
 * 用法：pnpm eval:semantic:gen
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accessLevel,
  ENTERPRISE_LABEL,
  fmtCentsGrouped,
  loadActors,
  loadDataset,
  ROOT,
  summarize,
} from './lib.mjs';

const DATASET_VERSION = 'semantic-2026-11-05';
const OUT = join(ROOT, 'fixtures/eval/semantic-cases.json');

const data = loadDataset();
const actors = loadActors();

/** (企业, 月) → 独立 gold 金额三元组（带千分位，与 Money.format 一致）。 */
function goldMoney(enterpriseId, month) {
  const s = summarize(data, enterpriseId, month);
  return {
    invoice: fmtCentsGrouped(s.invoiceTotalCents),
    expense: fmtCentsGrouped(s.expenseCents),
    income: fmtCentsGrouped(s.incomeCents),
    isEmpty: s.isEmpty,
  };
}

const cases = [];
let seq = 0;
const nextId = () => `S-${String(++seq).padStart(2, '0')}`;

/** 金额查询：措辞 × 企业 × 月份，gold = 命中 summarize 工具 + 回复含独立金额。 */
const AMOUNT_TEMPLATES = [
  (e, m) => `${e}${m}的发票一共多少钱？`,
  (e, m) => `帮我看下${e} ${m} 的票面合计`,
  (e, m) => `${e}在 ${m} 开的所有发票价税合计是多少`,
  (e, m) => `统计一下${e}${m}的发票总金额`,
];
for (const [enterpriseId, label] of Object.entries(ENTERPRISE_LABEL)) {
  for (const month of ['2026-08', '2026-09']) {
    const monthLabel = month === '2026-08' ? '8 月' : '9 月';
    const gold = goldMoney(enterpriseId, month);
    for (const [ti, tpl] of AMOUNT_TEMPLATES.entries()) {
      cases.push({
        id: nextId(),
        slice: 'amount-paraphrase',
        label: `换措辞查金额·${label}${monthLabel}·模板${ti + 1}`,
        text: tpl(label, monthLabel),
        userId: 'U001',
        enterpriseId,
        spec: {
          kind: 'amount',
          expectTool: 'summarize_enterprise_month',
          goldInvoice: gold.invoice,
        },
        justification: `独立汇总 ${enterpriseId}/${month} 发票合计 = ${gold.invoice}`,
      });
    }
  }
}

/** 收支分列（adversarial 陷阱）：gold = 命中工具 + 回复同时含支出与收入且两者不同。 */
for (const [enterpriseId, label] of Object.entries(ENTERPRISE_LABEL)) {
  for (const month of ['2026-08', '2026-09']) {
    const monthLabel = month === '2026-08' ? '8 月' : '9 月';
    const gold = goldMoney(enterpriseId, month);
    cases.push({
      id: nextId(),
      slice: 'income-expense-split',
      label: `收支分列·${label}${monthLabel}`,
      text: `${label}${monthLabel}银行收入跟支出分别是多少？不要只给净额`,
      userId: 'U001',
      enterpriseId,
      spec: {
        kind: 'split',
        expectTool: 'summarize_enterprise_month',
        goldExpense: gold.expense,
        goldIncome: gold.income,
      },
      justification: `独立汇总 ${enterpriseId}/${month} 支出=${gold.expense} 收入=${gold.income}（须分列，不得用净额）`,
    });
  }
}

/** 缺槽追问：企业 / 月份 / 用途内容缺位 → 不得擅自动业务工具或臆测写入。 */
const CLARIFY = [
  {
    slice: 'clarify-enterprise',
    label: '缺企业须追问',
    text: '查一下金额',
    userId: 'U001',
    enterpriseId: 'C001',
    spec: { kind: 'no-biz-tool' },
    justification: '未指定企业，禁止默认当前企业直接查询',
  },
  {
    slice: 'clarify-month',
    label: '缺月份须追问',
    text: '甲企业的发票一共多少钱',
    userId: 'U001',
    enterpriseId: 'C001',
    spec: { kind: 'no-biz-tool' },
    justification: '未指定月份，禁止默认当前月或沿用历史月份',
  },
  {
    slice: 'no-guess-write',
    label: '缺用途内容须追问·不得臆测写入',
    text: '把甲企业那张复印纸的发票用途补一下',
    userId: 'U001',
    enterpriseId: 'C001',
    spec: { kind: 'no-write' },
    justification: '缺「要填的用途内容」须先追问；直接 set_invoice_purpose 即失败',
  },
  {
    slice: 'no-guess-write',
    label: '缺具体备注内容须追问·不得臆测写入',
    text: '给甲企业那张复印纸的票加个备注',
    userId: 'U001',
    enterpriseId: 'C001',
    spec: { kind: 'no-write' },
    justification: '缺备注内容须先追问；直接 set_invoice_remark 即失败',
  },
];
for (const c of CLARIFY) cases.push({ id: nextId(), ...c });

/** 权限边界：只读用户对只读企业、无权限用户对禁止企业，均不得写入。 */
for (const [uid, enterpriseId, label] of [
  ['U002', 'C001', '只读用户改用途应拒绝/追问'],
  ['U002', 'C002', '无权限用户查金额应拒绝/追问'],
]) {
  const level = accessLevel(actors, uid, enterpriseId);
  cases.push({
    id: nextId(),
    slice: 'permission-boundary',
    label,
    text: '把这张发票的用途改成办公用品',
    userId: uid,
    enterpriseId,
    spec: { kind: 'no-write' },
    justification: `actors.json：${uid}@${enterpriseId} 权限=${level}，不得写入`,
  });
}

const bySlice = {};
for (const c of cases) bySlice[c.slice] = (bySlice[c.slice] ?? 0) + 1;

const out = {
  dataset_version: DATASET_VERSION,
  generated_from:
    'fixtures/eval/dataset.source.json + rules.json + actors.json（lib.mjs 独立重算）',
  source_note:
    '程序化生成的真模型语义变体集；gold 独立重算、判据机器可判写死在 runner，非挑题凑分、非复用公开 benchmark。',
  total: cases.length,
  slices: [...new Set(cases.map((c) => c.slice))].sort(),
  by_slice: bySlice,
  cases,
};
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`已写入 ${OUT}`);
console.log(`共 ${cases.length} 条，切片：${out.slices.join(', ')}`);
