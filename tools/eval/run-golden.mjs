#!/usr/bin/env node
/**
 * 黄金评测集 runner（消费冻结的 fixtures/eval/golden-cases.json）。
 *
 * 设计：**自包含、可复现、零外部状态**。不使用会跑脏的 dev DB / HTTP 服务，
 * 而是用一份**临时 SQLite 库从赛题 Excel 现场播种**（40 发票 / 48 流水 / 5 规则 /
 * 完整授权），在真实应用层用例上现算，再与独立 gold 比对。这样 gold 的「原始 Excel
 * 状态」前提永远成立，不受先前演示写入污染。
 *
 * 两类指标分开评分（对标 RAG 标准：retrieval / generation）：
 *   - retrieval：gold_sources.rules 与真实 `selectApplicableRules` 装配出的规则集合是否一致。
 *   - answer：gold_answer 与真实用例（summarizeMonth / findPurposeGaps / explainRules /
 *     accessLevel）在原始播种库上的计算结果是否一致。
 *
 * 诚实边界：
 *   - 这是「确定性管线 + 真实用例」评分，不是真 LLM 语义理解（那需 demo:semantic:live / L6）。
 *   - gold 由 lib.mjs 独立重算，与被测用例不共用实现；切片标签与问题为程序生成。
 *   - 依赖已构建的 `packages/{adapters,application,domain}/dist`（`pnpm build` 产物）。
 *
 * 用法：pnpm eval:golden [--json] [--markdown]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const asMarkdown = args.includes('--markdown');

const dataset = JSON.parse(readFileSync(join(ROOT, 'fixtures/eval/golden-cases.json'), 'utf8'));

/* --------------------------- 依赖装配 --------------------------- */
// 用真实适配器 + 一份临时 SQLite 库（从赛题 Excel 现场播种），保证数据与
// dataset.source.json（gold 来源）一致且零外部状态。不依赖 dev DB / HTTP 服务。
const { openDatabase, SqliteUnitOfWork, loadAll } = await import(
  '../../packages/adapters/dist/index.js'
);
const { summarizeMonth, findPurposeGaps, explainRules } = await import(
  '../../packages/application/dist/index.js'
);
const domain = await import('../../packages/domain/dist/index.js');
const { loadRules } = await import('./lib.mjs');

const TMP_DB = join(ROOT, 'data/golden-tmp.db');
// 清理上次残留（WAL/SHM）
for (const suffix of ['', '-wal', '-shm']) {
  const p = `${TMP_DB}${suffix}`;
  if (existsSync(p)) {
    try {
      (await import('node:fs')).unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}
const db = openDatabase(TMP_DB);
await loadAll(
  db,
  join(ROOT, 'fixtures/excel/02_示例数据.xlsx'),
  join(ROOT, 'fixtures/rules.seed.json'),
);

/** 每条用例一份新 UoW（共享已播种的原始库；用例只读，不跨用例写状态）。 */
function fresh() {
  const uow = new SqliteUnitOfWork(db);
  const deps = {
    uow,
    clock: { now: () => new Date('2026-09-15T10:00:00+08:00'), today: () => '2026-09-15' },
    ids: { next: (p) => `${p}_g` },
  };
  return { uow, deps };
}

/** 独立格式化（与 gold 同源算法，不取被测结果）。 */
function fmt(cents) {
  const n = BigInt(cents);
  const yuan = n / 100n;
  const fen = (n % 100n).toString().padStart(2, '0');
  return `${yuan.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fen}`;
}
const ids = (rows) => rows.map((r) => `${r.code}@${r.version}`).sort();

/* --------------------------- retrieval --------------------------- */
/** 真实 selectApplicableRules 装配出的规则 vs gold_sources.rules。 */
function retrievalMatch(c, ruleDocs) {
  const sel = domain.selectApplicableRules({
    candidates: ruleDocs,
    scope: domain.enterpriseId(c.query.enterpriseId),
    asOfMonth: domain.parseMonth(c.query.month),
    at: domain.parseIsoDate(`${c.query.month}-10`),
  });
  const got = ids(sel.selected.map((r) => ({ code: r.code, version: r.version })));
  const want = [...(c.gold_sources.rules ?? [])].sort();
  // permission 切片无规则检索标注 → N/A，不计分
  if (want.length === 0 && c.slice_tag === 'permission')
    return { ok: null, why: 'N/A（权限切片无规则检索）' };
  return {
    ok: JSON.stringify(got) === JSON.stringify(want),
    why: `selected=[${got}] vs gold=[${want}]`,
  };
}

/** 从原始 JSON 规则构造 RuleDocument（与 world 同源，但用独立 lib 数据）。 */
function ruleDocsOf(D) {
  const rs = loadRules();
  return rs.map((r) =>
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
      obligation: r.obligation ?? null,
      body: `${r.title} ${r.version} 正文`,
      supersedes: null,
      supersededBy: null,
      updatedAt: D.parseIsoDate('2026-01-01'),
      revision: 0,
    }),
  );
}
const ruleDocs = ruleDocsOf(domain);

/* --------------------------- answer --------------------------- */
/** 在原始播种库上跑真实用例，把结果与独立 gold 比对。 */
async function answerMatch(c) {
  const { deps } = fresh();
  const eid = domain.enterpriseId(c.query.enterpriseId);
  const uid = c.query.userId;
  const actor = domain.userId(uid);
  const month = domain.parseMonth(c.query.month);
  const scope = { actor, enterpriseId: eid, month };
  const g = c.gold_answer;

  // permission 切片：判「权限级别」而非金额。用独立 actors.json 复算期望级别，
  // 再核对系统在用例层是否按该权限放行/拒绝（denied=none，其余允许查询）。
  if (c.slice_tag === 'permission') {
    const actors = (await import('./lib.mjs')).loadActors();
    const user = actors.users.find((u) => u.userId === uid);
    const level = user?.grants?.[c.query.enterpriseId] ?? 'none';
    const r = await summarizeMonth(deps, scope);
    const expectDenied = level === 'none';
    const ok = expectDenied ? r.kind === 'denied' : r.kind === 'ok' || r.kind === 'empty';
    return {
      ok: ok && level === g.accessLevel,
      why: `actors级别=${level} gold=${g.accessLevel} 系统kind=${r.kind}`,
    };
  }

  // edge（空月）：系统返回 kind=empty 且说明「无记录」即为正确，不应按金额匹配。
  if (c.slice_tag === 'edge') {
    const r = await summarizeMonth(deps, scope);
    return { ok: r.kind === 'empty', why: `空月应 kind=empty，实际 ${r.kind}` };
  }

  // adversarial 陷阱：系统必须「收支分列」，即 expense/income 分别给出且不等于净额。
  if (c.slice_tag === 'adversarial') {
    const r = await summarizeMonth(deps, scope);
    if (r.kind !== 'ok') return { ok: false, why: `summarizeMonth kind=${r.kind}` };
    const exp = r.bank.expense.formatted;
    const inc = r.bank.income.formatted;
    const ok =
      exp !== inc && Number(exp.replace(/,/g, '')) > 0 && Number(inc.replace(/,/g, '')) > 0;
    return { ok, why: `收支分列 exp=${exp} inc=${inc}（不得用净额代替）` };
  }

  switch (c.expected_tool) {
    case 'summarize_enterprise_month': {
      const r = await summarizeMonth(deps, scope);
      if (c.slice_tag === 'permission' && g.accessLevel === 'none') {
        return { ok: r.kind === 'denied', why: `无权用户应 denied，实际 kind=${r.kind}` };
      }
      if (r.kind !== 'ok') return { ok: false, why: `summarizeMonth kind=${r.kind}` };
      const inv = r.invoice.total.formatted;
      const exp = r.bank.expense.formatted;
      const inc = r.bank.income.formatted;
      const okInv = String(inv) === (g.invoiceTotal ?? fmt(0));
      const okExp = g.bankExpense === undefined || String(exp) === g.bankExpense;
      const okInc = g.bankIncome === undefined || String(inc) === g.bankIncome;
      return {
        ok: okInv && okExp && okInc,
        why: `inv=${inv} exp=${exp} inc=${inc} vs gold inv=${g.invoiceTotal}`,
      };
    }
    case 'find_purpose_gaps': {
      const r = await findPurposeGaps(deps, scope);
      if (r.kind !== 'ok') return { ok: false, why: `findPurposeGaps kind=${r.kind}` };
      const got = r.gaps.map((x) => x.invoiceNo).sort();
      const want = [...(g.missing ?? [])].sort();
      return {
        ok: JSON.stringify(got) === JSON.stringify(want),
        why: `gaps=[${got}] vs gold=[${want}]`,
      };
    }
    case 'explain_rules': {
      const r = await explainRules(deps, scope);
      if (r.kind !== 'ok') return { ok: false, why: `explainRules kind=${r.kind}` };
      const got = ids(r.applied);
      const want = [...(g.selectedRules ?? [])].sort();
      return {
        ok: JSON.stringify(got) === JSON.stringify(want),
        why: `applied=[${got}] vs gold=[${want}]`,
      };
    }
    default:
      return { ok: false, why: `未处理的工具 ${c.expected_tool}` };
  }
}

/* --------------------------- 执行 --------------------------- */
const results = [];
for (const c of dataset.cases) {
  const r = { id: c.id, slice: c.slice_tag, question: c.question };
  const rm = retrievalMatch(c, ruleDocs);
  r.retrieval = rm.ok === null ? 'N/A' : rm.ok;
  r.retrievalWhy = rm.why;
  try {
    const am = await answerMatch(c);
    r.answer = am.ok;
    r.answerWhy = am.why;
  } catch (e) {
    r.answer = false;
    r.answerWhy = String(e).slice(0, 160);
  }
  results.push(r);
}

/* --------------------------- 计分 --------------------------- */
const sliceStats = {};
for (const r of results) {
  if (sliceStats[r.slice] === undefined) {
    sliceStats[r.slice] = { total: 0, retrievalOk: 0, retrievalN: 0, answerOk: 0 };
  }
  const s = sliceStats[r.slice];
  s.total += 1;
  if (r.retrieval !== 'N/A') {
    s.retrievalN += 1;
    if (r.retrieval === true) s.retrievalOk += 1;
  }
  if (r.answer === true) s.answerOk += 1;
}
const retrievalN = results.filter((r) => r.retrieval !== 'N/A').length;
const retrievalOk = results.filter((r) => r.retrieval === true).length;
const answerOk = results.filter((r) => r.answer === true).length;
const overall = {
  total: results.length,
  dataset_version: dataset.dataset_version,
  mode: 'deterministic-pipeline (seeded-from-Excel temp SQLite, real use-cases, no LLM, no shared DB)',
  retrieval: { ok: retrievalOk, n: retrievalN, rate: retrievalN ? retrievalOk / retrievalN : 0 },
  answer: { ok: answerOk, n: results.length, rate: answerOk / results.length },
  by_slice: sliceStats,
  results,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(overall, null, 2)}\n`);
} else if (asMarkdown) {
  const lines = [
    '# 黄金评测集报告',
    '',
    `数据集版本：\`${dataset.dataset_version}\` · 共 ${results.length} 条 · ${overall.mode}`,
    '',
    '| 切片 | 条数 | retrieval 命中 | answer 命中 |',
    '|---|---|---|---|',
  ];
  for (const [s, v] of Object.entries(sliceStats)) {
    lines.push(
      `| ${s} | ${v.total} | ${v.retrievalOk}/${v.retrievalN} | ${v.answerOk}/${v.total} |`,
    );
  }
  lines.push(
    '',
    `合计：retrieval ${retrievalOk}/${retrievalN} (${(overall.retrieval.rate * 100).toFixed(1)}%) · answer ${answerOk}/${results.length} (${(overall.answer.rate * 100).toFixed(1)}%)`,
    '',
    '> 确定性管线评分（Excel 现场播种的临时 SQLite + 真实用例），gold 由 lib.mjs 独立重算；' +
      '非真 LLM 语义理解（见 pnpm demo:semantic:live / L6）。',
    '',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
} else {
  console.log(`\n=== 黄金评测集（${dataset.dataset_version}，${results.length} 条）===\n`);
  console.log(
    '  模式：确定性管线（Excel 现场播种临时 SQLite + 真实用例，零外部状态 / 无 LLM）。\n',
  );
  for (const [s, v] of Object.entries(sliceStats)) {
    console.log(
      `  ${s.padEnd(12)} ${String(v.total).padStart(2)} 条  | retrieval ${v.retrievalOk}/${v.retrievalN}  answer ${v.answerOk}/${v.total}`,
    );
  }
  console.log(
    `\n  合计：retrieval ${retrievalOk}/${retrievalN} (${(overall.retrieval.rate * 100).toFixed(1)}%) · answer ${answerOk}/${results.length} (${(overall.answer.rate * 100).toFixed(1)}%)`,
  );
  console.log(
    '  说明：gold 由 lib.mjs 独立重算，与被测用例不共用实现；真模型语义见 demo:semantic:live。\n',
  );
}
db.close();
for (const suffix of ['', '-wal', '-shm']) {
  const p = `${TMP_DB}${suffix}`;
  if (existsSync(p)) {
    try {
      (await import('node:fs')).unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}
process.exit(overall.answer.rate >= 0.9 && overall.retrieval.rate >= 0.9 ? 0 : 1);
