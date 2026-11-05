#!/usr/bin/env node
/**
 * 财税 Agent Harness 评测中台统一执行引擎。
 *
 * 规范参考：
 * - 7大构建维度（结果、RAG检索、证据、Agent过程、异常、成本效率、安全权限）
 * - OpenAI Agent Evals (Traces, Graders, Datasets, Eval Runs)
 * - NVIDIA Agent Process Evaluation (step-level + outcome)
 * - Meta Agents Rule of Two (不可信输入、敏感系统、写操作边界)
 *
 * 用法：
 *   node tools/eval/run-eval.mjs                 # 跑全量并输出 7 维雷达健康度
 *   node tools/eval/run-eval.mjs --layer=l1      # 跑单层 (l1..l7)
 *   node tools/eval/run-eval.mjs --json          # 机器可读 JSON
 *   node tools/eval/run-eval.mjs --markdown      # 生成带 7 维诊断的 Markdown 报告
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { l1DomainCases } from './cases/l1-domain.mjs';
import { l2Cases } from './cases/l2-application.mjs';
import { l3Cases } from './cases/l3-adapters.mjs';
import { l4Cases } from './cases/l4-runtime.mjs';
import { l5Cases } from './cases/l5-e2e.mjs';
import { l6Cases } from './cases/l6-realmodel.mjs';
import { l7Cases } from './cases/l7-architecture.mjs';
import {
  aggregateDimensions,
  classifyDimensions,
  OFFICIAL_DIMENSIONS,
} from './eval-dimensions.mjs';
import { l1Registry } from './l1-registry.mjs';
import { l2RegistryAsync } from './l2-registry.mjs';
import { runL3Case } from './l3-registry.mjs';
import { runL4Case } from './l4-registry.mjs';
import { runL5Case } from './l5-registry.mjs';
import { checkL7 } from './l7-checks.mjs';
import {
  auditPurposes,
  ENTERPRISES,
  EXPECTED_SEPTEMBER,
  fmtCents,
  loadDataset,
  loadRules,
  purposeObligation,
  ROOT,
  summarize,
} from './lib.mjs';
import { computeRetrievalMetrics } from './retrieval-metrics.mjs';
import { computeGolden } from './run-golden.mjs';
import { computeVectorMetrics } from './vector-metrics.mjs';

const args = process.argv.slice(2);
const layerArg = args.find((a) => a.startsWith('--layer='))?.split('=')[1];
const asJson = args.includes('--json');
const asMarkdown = args.includes('--markdown');

/* ------------------------------ 断言比对器 ------------------------------ */

const ERROR_ALIASES = {
  InvalidMoneyError: ['InvalidMoneyError'],
  InvalidIdentifierError: ['InvalidIdentifierError'],
  InvalidTextError: ['InvalidTextError', 'EmptyTextError'],
  InvoiceInvariantError: ['InvoiceInvariantError', 'AccessDeniedError'],
  IdempotencyConflictError: ['IdempotencyConflictError'],
  RuleSelectionAmbiguousError: ['RuleSelectionAmbiguousError'],
  TaskCardStateError: ['TaskCardStateError', 'TaskInProgressError'],
};

function compare(actual, expect) {
  // 字符串 expect = 只有人读描述、没有机器断言。
  // **绝不能当成通过**：那会让「没写断言」伪装成「验证过了」。
  if (typeof expect === 'string') {
    return { unverified: true };
  }
  const failures = [];

  if (expect.throws !== undefined) {
    return { failures: [`应抛出 ${expect.throws}，但正常返回`] };
  }
  if (actual === undefined) return { failures: ['无返回值'] };

  for (const [key, want] of Object.entries(expect)) {
    const got = actual[key];
    if (key === 'rejectedHas') {
      const gotList = Array.isArray(got) ? got : [];
      for (const item of want) {
        if (!gotList.includes(item)) failures.push(`rejected 缺少 ${item}`);
      }
      continue;
    }
    if (Array.isArray(want)) {
      const a = JSON.stringify(got);
      const b = JSON.stringify(want);
      if (a !== b) failures.push(`${key}: 期望 ${b}，实际 ${a}`);
      continue;
    }
    if (got !== want) {
      failures.push(`${key}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
    }
  }
  return { failures };
}

function runSimple(c) {
  const D = l1Registry.__domain;
  if (D === undefined) return { failures: ['domain 未加载'] };

  const args = [...(c.input ?? [])];

  const isInstanceMethod =
    c.fn.startsWith('Money.') && !['Money.parse', 'Money.fromCents', 'Money.zero'].includes(c.fn);

  const target = isInstanceMethod
    ? D.Money.prototype[c.fn.slice('Money.'.length)]
    : resolveFn(D, c.fn);
  if (target === undefined) return { failures: [`无法解析 ${c.fn}`] };

  let result;
  try {
    if (isInstanceMethod) {
      const method = c.fn.slice('Money.'.length);
      const receiver = D.Money.fromCents(BigInt(args[0]));
      const rest = args
        .slice(1)
        .map((a) =>
          method === 'add' ||
          method === 'subtract' ||
          method === 'compare' ||
          method === 'gte' ||
          method === 'equals'
            ? D.Money.fromCents(BigInt(a))
            : a,
        );
      result =
        method === 'format' ? receiver.format(...(c.options ?? [])) : receiver[method](...rest);
    } else {
      if (c.wrap === 'fromCents') {
        args[0] = D.Money.fromCents(BigInt(args[0]));
      }
      result = target(...args);
    }
  } catch (err) {
    if (c.expect.throws !== undefined) {
      const ok = (ERROR_ALIASES[c.expect.throws] ?? [c.expect.throws]).includes(err.name);
      return { failures: ok ? [] : [`期望 ${c.expect.throws}，实际抛 ${err.name}`] };
    }
    return { failures: [`意外抛错 ${err.name}: ${err.message}`] };
  }

  let actual;
  if (typeof result === 'string') {
    actual = { text: result };
  } else if (result instanceof D.Money) {
    actual = { cents: result.cents.toString(), text: result.format({ grouped: false }) };
  } else if (result instanceof D.InvoiceId) {
    actual = { text: result.value() };
  } else if (typeof result === 'boolean') {
    actual = { value: result };
  } else {
    actual = result;
  }
  if (actual !== null && typeof actual === 'object' && 'actual' in actual) {
    return compare(actual.actual, c.expect);
  }
  return compare(actual, c.expect);
}

function resolveFn(D, path) {
  return path
    .split('.')
    .reduce((acc, k) => (acc === undefined || acc === null ? undefined : acc[k]), D);
}

async function runCustom(c, registry = l1Registry) {
  const fn = registry[c.custom];
  if (typeof fn !== 'function') return { failures: [`未注册 custom: ${c.custom}`] };

  let actual;
  try {
    actual = await fn(c.input ?? {});
  } catch (err) {
    if (c.expect.throws !== undefined) {
      const ok = (ERROR_ALIASES[c.expect.throws] ?? [c.expect.throws]).includes(err.name);
      return {
        failures: ok ? [] : [`期望 ${c.expect.throws}，实际抛 ${err.name}: ${err.message}`],
      };
    }
    return { failures: [`意外抛错 ${err.name}: ${err.message}`] };
  }
  const payload =
    actual !== null && typeof actual === 'object' && 'actual' in actual ? actual.actual : actual;
  return compare(payload, c.expect);
}

/* ------------------------------ 基准自检 ------------------------------ */

function verifyGolden() {
  const data = loadDataset();
  const rules = loadRules();
  const problems = [];

  const expected = {
    'C001/2026-08': [904635n, 572099n, 1485075n],
    'C001/2026-09': [962206n, 718074n, 1300050n],
    'C002/2026-08': [1366705n, 934110n, 1880025n],
    'C002/2026-09': [1266724n, 808724n, 1370075n],
  };

  for (const [key, [total, expense, income]] of Object.entries(expected)) {
    const [ent, month] = key.split('/');
    const s = summarize(data, ent, month);
    if (s.invoiceTotalCents !== total) {
      problems.push(`${key} 发票合计 ${fmtCents(s.invoiceTotalCents)} ≠ ${fmtCents(total)}`);
    }
    if (s.expenseCents !== expense) {
      problems.push(`${key} 支出 ${fmtCents(s.expenseCents)} ≠ ${fmtCents(expense)}`);
    }
    if (s.incomeCents !== income) {
      problems.push(`${key} 收入 ${fmtCents(s.incomeCents)} ≠ ${fmtCents(income)}`);
    }
  }

  for (const ent of ENTERPRISES) {
    const s = summarize(data, ent, '2026-07');
    if (!s.isEmpty) problems.push(`${ent}/2026-07 应为空月`);
  }

  for (const ent of ENTERPRISES) {
    const ob = purposeObligation(rules, ent, '2026-09');
    if (ob === null) {
      problems.push(`${ent}/2026-09 缺少适用用途规则`);
      continue;
    }
    const audit = auditPurposes(data, ent, '2026-09', ob);
    const gotMissing = audit.missing.map((i) => i.invoiceNo).sort();
    const gotOptional = audit.optional.map((i) => i.invoiceNo).sort();
    const want = EXPECTED_SEPTEMBER[ent];
    if (JSON.stringify(gotMissing) !== JSON.stringify([...want.missing].sort())) {
      problems.push(`${ent} 缺项 ${JSON.stringify(gotMissing)} ≠ ${JSON.stringify(want.missing)}`);
    }
    if (JSON.stringify(gotOptional) !== JSON.stringify([...want.optional].sort())) {
      problems.push(
        `${ent} 可空项 ${JSON.stringify(gotOptional)} ≠ ${JSON.stringify(want.optional)}`,
      );
    }
  }

  return problems;
}

/* -------------------------------- 主流程 -------------------------------- */

const EXECUTABLE = {
  l1: {
    cases: l1DomainCases,
    run: (c) => (c.custom !== undefined ? runCustom(c, l1Registry) : runSimple(c)),
  },
  l2: {
    cases: l2Cases,
    run: (c) => (c.custom === undefined ? null : runCustom(c, l2RegistryAsync)),
  },
  l3: { cases: l3Cases, run: runL3Case },
  l4: { cases: l4Cases, run: runL4Case },
  l5: { cases: l5Cases, run: runL5Case },
  l6: { cases: l6Cases, run: null },
  l7: { cases: l7Cases, run: null },
};

const DEPENDENCY = {
  l1: 'packages/domain/dist/index.js',
  l2: 'packages/application/dist/index.js',
  l3: 'packages/adapters/dist/index.js',
  l4: 'packages/runtime/dist/index.js',
  l5: 'packages/runtime/dist/index.js',
  l6: null,
  l7: '.dependency-cruiser.cjs',
};

const results = [];
const goldenProblems = verifyGolden();

if (existsSync(join(ROOT, DEPENDENCY.l1))) {
  const mod = await import('../../packages/domain/dist/index.js');
  l1Registry.__domain = mod;
}

for (const [layer, def] of Object.entries(EXECUTABLE)) {
  if (layerArg !== undefined && layer !== layerArg) continue;

  const dep = DEPENDENCY[layer];
  const available = dep === null ? true : existsSync(join(ROOT, dep));

  for (const c of def.cases) {
    let status;
    let failures = [];

    if (c.kind === 'manual') {
      status = 'MANUAL';
    } else if (layer === 'l7') {
      // P0-3：真正跑 depcruise/源码扫描，按 rule 断言零违规，不再用 existsSync 假 PASS。
      const r = checkL7(c);
      failures = r.failures;
      status = failures.length === 0 ? 'PASS' : 'FAIL';
    } else if (!available) {
      status = 'BLOCKED';
      failures = [`缺少 ${dep}`];
    } else if (def.run === null) {
      status = 'BLOCKED';
      failures = [`${layer} 执行器未实现`];
    } else {
      const r = await def.run(c);
      if (r === null) {
        status = 'PENDING';
        failures = ['该用例尚未接入执行器（registry 未指定）'];
        results.push({
          layer,
          id: c.id,
          title: c.title,
          status,
          failures,
          invariants: c.invariants ?? [],
          requirement: c.requirement ?? null,
          source: c.source ?? null,
          dimensions: classifyDimensions(c),
        });
        continue;
      }
      if (r.unverified === true) {
        failures = ['该用例只有文字描述，未写可执行断言'];
        status = 'UNVERIFIED';
      } else {
        failures = r.failures ?? [];
        status = failures.length === 0 ? 'PASS' : 'FAIL';
      }
    }

    results.push({
      layer,
      id: c.id,
      title: c.title,
      status,
      failures,
      invariants: c.invariants ?? [],
      requirement: c.requirement ?? null,
      source: c.source ?? null,
      dimensions: classifyDimensions(c),
    });
  }
}

/* -------------------------------- 输出与报告 -------------------------------- */
const dimensionsSummary = aggregateDimensions(results);

/** 真实 IR 检索指标（确定性规则检索，非向量）：Precision/Recall/F1/版本命中率。 */
const retrieval = await computeRetrievalMetrics();

/** 标准黄金评测集（50 条，独立真值）：retrieval/answer 分开计分，并入中台统一报告。 */
const goldenDataset = await computeGolden();

/** 向量检索 IR 基线（本地确定性哈希嵌入 + 余弦 top-K），回答「向量化分数」。 */
const vector = await computeVectorMetrics();

const summary = {
  /** 赛题官方评分维度（权重来自 01_参赛说明.docx），评测中台不替代评委评分。 */
  officialDimensions: OFFICIAL_DIMENSIONS,
  disclaimer:
    '7 维雷达为内部工程指标，非赛题评分维度；比赛按官方 5 维由评委结合演示/运行记录核定。',
  golden: { ok: goldenProblems.length === 0, problems: goldenProblems },
  total: results.length,
  byStatus: results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {}),
  byLayer: Object.keys(EXECUTABLE).reduce((acc, l) => {
    const layerResults = results.filter((r) => r.layer === l);
    acc[l] = {
      total: layerResults.length,
      pass: layerResults.filter((r) => r.status === 'PASS').length,
      fail: layerResults.filter((r) => r.status === 'FAIL').length,
      blocked: layerResults.filter((r) => r.status === 'BLOCKED').length,
      pending: layerResults.filter((r) => r.status === 'PENDING').length,
      unverified: layerResults.filter((r) => r.status === 'UNVERIFIED').length,
      manual: layerResults.filter((r) => r.status === 'MANUAL').length,
    };
    return acc;
  }, {}),
  dimensions: dimensionsSummary,
  retrieval,
  vector,
  goldenDataset,
  results,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else if (asMarkdown) {
  const lines = [];
  lines.push('# 财税 Agent Harness 评测执行报告');
  lines.push('');
  lines.push(
    `- 基准自检：${summary.golden.ok ? '✅ 全部通过（与 Excel 严格一致）' : '❌ 失败（存在数据漂移）'}`,
  );
  if (!summary.golden.ok) {
    for (const p of summary.golden.problems) lines.push(`  - ${p}`);
  }
  lines.push('');
  lines.push('## 〇、赛题官方评分维度（评委口径，评测中台不替代评分）');
  lines.push('');
  lines.push('| 维度 | 权重 | 看什么 |');
  lines.push('|---|---|---|');
  for (const d of OFFICIAL_DIMENSIONS) {
    lines.push(`| ${d.name} | ${(d.weight * 100).toFixed(0)}% | ${d.look} |`);
  }
  lines.push('');
  lines.push(`> ${summary.disclaimer}`);
  lines.push('');
  lines.push('## 一、分层执行概览 (Levels L1-L7)');
  lines.push('');
  lines.push(
    '| 层级 | 覆盖模块 | 用例数 | PASS | FAIL | PENDING | UNVERIFIED | BLOCKED | MANUAL |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const [l, s] of Object.entries(summary.byLayer)) {
    if (s.total === 0) continue;
    lines.push(
      `| ${l.toUpperCase()} | ${l} | ${s.total} | ${s.pass} | ${s.fail} | ${s.pending} | ${s.unverified} | ${s.blocked} | ${s.manual} |`,
    );
  }
  lines.push('');
  lines.push('## 二、内部工程维度雷达（非赛题评分口径，仅供工程自测）');
  lines.push('');
  lines.push('| 维度 | 目标准则 | 去重用例数 | 被标记次数 | 已通过 | 当前通过率 | 状态 | 说明 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const [_key, d] of Object.entries(dimensionsSummary)) {
    const pct = d.score === null ? 'N/A' : `${(d.score * 100).toFixed(1)}%`;
    const tag =
      d.fail > 0
        ? '❌ 未通过'
        : d.score === null
          ? '➖ N/A'
          : d.score >= d.target
            ? '✅ 达标'
            : '⚠️ 关注';
    lines.push(
      `| **${d.name}** | ≥ ${(d.target * 100).toFixed(0)}% | ${d.uniqueCases} | ${d.taggedCount} | ${d.pass} | ${pct} | ${tag} | ${d.desc} |`,
    );
  }
  lines.push('');
  lines.push('## 三、规则检索效果 (Retrieval · 确定性检索，非向量 IR)');
  lines.push('');
  if (!retrieval.available) {
    lines.push(`> 未计算：${retrieval.reason}`);
  } else {
    const m = retrieval.macro;
    lines.push('| 指标 | 值 | 说明 |');
    lines.push('|---|---|---|');
    lines.push(
      `| Precision (macro) | ${(m.precision * 100).toFixed(1)}% | 检索结果中相关规则占比 |`,
    );
    lines.push(`| Recall (macro) | ${(m.recall * 100).toFixed(1)}% | 应检索规则被找回占比 |`);
    lines.push(`| F1 (macro) | ${(m.f1 * 100).toFixed(1)}% | P/R 调和平均 |`);
    lines.push(
      `| 版本命中率 | ${(m.versionHitRate * 100).toFixed(1)}% | selected 集合与 gold 完全一致（含版本）的查询占比 |`,
    );
    lines.push(
      `| F1 (micro) | ${(m.micro.f1 * 100).toFixed(1)}% | 汇总 TP=${m.micro.tp} FP=${m.micro.fp} FN=${m.micro.fn} |`,
    );
    lines.push('');
    lines.push(
      `> ${m.queryCount} 个查询（2 企业 × 3 月份）× ${m.candidateCount} 条候选规则；被测 = 真实 \`selectApplicableRules\`，gold 独立硬编码。`,
    );
    lines.push('');
    lines.push('| 查询 | gold | retrieved | P | R | F1 | 版本完全一致 |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const q of retrieval.queries) {
      lines.push(
        `| ${q.enterprise}/${q.month} | ${q.gold.join(', ')} | ${q.retrieved.join(', ')} | ${(q.precision * 100).toFixed(0)}% | ${(q.recall * 100).toFixed(0)}% | ${(q.f1 * 100).toFixed(0)}% | ${q.versionExact ? '✅' : '❌'} |`,
      );
    }
  }
  lines.push('');

  // 四、向量检索 IR 基线（真实可复算的余弦分数）
  lines.push('## 四、向量检索基线 (Vector IR · 本地确定性哈希嵌入 + 余弦)');
  lines.push('');
  lines.push(`> ${vector.disclaimer}`);
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  lines.push(`| Precision (macro) | ${(vector.macro.precision * 100).toFixed(1)}% |`);
  lines.push(`| Recall (macro) | ${(vector.macro.recall * 100).toFixed(1)}% |`);
  lines.push(`| F1 (macro) | ${(vector.macro.f1 * 100).toFixed(1)}% |`);
  lines.push(`| top-K | ${vector.macro.topK}（= 每查询 gold 规则数） |`);
  lines.push(`| 查询数 × 候选数 | ${vector.macro.queryCount} × ${vector.macro.candidateCount} |`);
  lines.push('');
  lines.push('| 查询 | gold | 向量 top-K retrieved | P | R | F1 | 版本一致 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const q of vector.queries) {
    lines.push(
      `| ${q.enterprise}/${q.month} | ${q.gold.join(', ')} | ${q.retrieved.join(', ')} | ${(q.precision * 100).toFixed(0)}% | ${(q.recall * 100).toFixed(0)}% | ${(q.f1 * 100).toFixed(0)}% | ${q.versionExact ? '✅' : '❌'} |`,
    );
  }
  lines.push('');
  lines.push(`> 方法：${vector.method}`);
  lines.push('');

  // 五、标准黄金评测集（50 条，独立真值）
  lines.push('## 五、标准黄金评测集 (Golden Dataset · 50 条确定性管线)');
  lines.push('');
  lines.push(
    `> 数据集版本 \`${goldenDataset.dataset_version}\` · ${goldenDataset.total} 条 · \`${goldenDataset.mode}\`。`,
  );
  lines.push(
    '> gold_answer / gold_sources 由 lib.mjs 独立重算，非被测代码；与 244 例回归套件区分。',
  );
  lines.push('');
  lines.push('| 切片 | 条数 | retrieval 命中 | answer 命中 |');
  lines.push('|---|---|---|---|');
  for (const [s, v] of Object.entries(goldenDataset.by_slice)) {
    lines.push(
      `| ${s} | ${v.total} | ${v.retrievalOk}/${v.retrievalN} | ${v.answerOk}/${v.total} |`,
    );
  }
  lines.push('');
  lines.push(
    `合计：retrieval ${goldenDataset.retrieval.ok}/${goldenDataset.retrieval.n} (${(goldenDataset.retrieval.rate * 100).toFixed(1)}%) · answer ${goldenDataset.answer.ok}/${goldenDataset.answer.n} (${(goldenDataset.answer.rate * 100).toFixed(1)}%)`,
  );
  lines.push('');
  const failed = results.filter((r) => r.status === 'FAIL');
  if (failed.length > 0) {
    lines.push('## 六、失败用例详情');
    lines.push('');
    for (const f of failed) {
      lines.push(`### ${f.id} · ${f.title}`);
      for (const msg of f.failures) lines.push(`- ${msg}`);
      lines.push('');
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
} else {
  const icon = {
    PASS: '✅',
    FAIL: '❌',
    BLOCKED: '⏸',
    PENDING: '◻',
    UNVERIFIED: '⚠',
    MANUAL: '👤',
  };
  process.stdout.write('\n基准自检：');
  if (summary.golden.ok) {
    process.stdout.write('✅ 全部金额与缺项与 Excel 一致\n');
  } else {
    process.stdout.write('❌ 数据漂移\n');
    for (const p of summary.golden.problems) process.stdout.write(`   - ${p}\n`);
  }

  process.stdout.write('\n分层执行 (Layers L1-L7)：\n');
  for (const [l, s] of Object.entries(summary.byLayer)) {
    if (s.total === 0) continue;
    process.stdout.write(
      `  ${l.toUpperCase()}  ${String(s.total).padStart(3)} 例   ✅${String(s.pass).padStart(3)}  ❌${String(s.fail).padStart(3)}  ◻${String(s.pending).padStart(3)}  ⚠${String(s.unverified).padStart(3)}  ⏸${String(s.blocked).padStart(3)}  👤${String(s.manual).padStart(3)}\n`,
    );
  }

  process.stdout.write('\n赛题官方评分维度（评委口径，评测中台不替代评分）：\n');
  for (const d of OFFICIAL_DIMENSIONS) {
    process.stdout.write(`  ${(d.weight * 100).toFixed(0).padStart(2)}%  ${d.name} — ${d.look}\n`);
  }
  process.stdout.write(`  · ${summary.disclaimer}\n`);

  process.stdout.write('\n内部工程维度雷达（非赛题评分口径，仅供工程自测）：\n');
  for (const d of Object.values(dimensionsSummary)) {
    const rate = d.score === null ? '   N/A' : `${(d.score * 100).toFixed(1)}%`.padStart(6);
    const tag =
      d.fail > 0
        ? '❌ FAIL'
        : d.score === null
          ? '➖ N/A'
          : d.score >= d.target
            ? '✅ EXCELLENT'
            : '⚠️ DEGRADED';
    process.stdout.write(
      `  ${tag.padEnd(12)} [${rate}] (通过${String(d.pass).padStart(3)}/去重${String(d.uniqueCases).padStart(3)}/标记${String(d.taggedCount).padStart(3)})  ${d.name}\n`,
    );
  }

  process.stdout.write('\n规则检索效果 (Retrieval · 确定性检索 / 非向量 IR)：\n');
  if (!retrieval.available) {
    process.stdout.write(`  · 未计算：${retrieval.reason}\n`);
  } else {
    const m = retrieval.macro;
    const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(6);
    process.stdout.write(
      `  Precision ${pct(m.precision)}  Recall ${pct(m.recall)}  F1 ${pct(m.f1)}  ` +
        `版本命中率 ${pct(m.versionHitRate)}  (micro F1 ${pct(m.micro.f1)}, ` +
        `TP=${m.micro.tp} FP=${m.micro.fp} FN=${m.micro.fn})\n`,
    );
    process.stdout.write(
      `  · ${m.queryCount} 查询 × ${m.candidateCount} 候选规则；被测 = 真实 selectApplicableRules，gold 独立硬编码\n`,
    );
  }

  process.stdout.write(
    '\n向量检索基线 (Vector IR · 本地哈希嵌入 + 余弦，非语义 embedding 模型)：\n',
  );
  {
    const m = vector.macro;
    const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(6);
    process.stdout.write(
      `  Precision ${pct(m.precision)}  Recall ${pct(m.recall)}  F1 ${pct(m.f1)}  ` +
        `top-K=${m.topK}  (${m.queryCount} 查询 × ${m.candidateCount} 候选规则)\n`,
    );
    process.stdout.write(`  · ${vector.disclaimer}\n`);
  }

  process.stdout.write('\n标准黄金评测集 (Golden Dataset · 50 条确定性管线)：\n');
  {
    const r = goldenDataset.retrieval;
    const a = goldenDataset.answer;
    const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(6);
    process.stdout.write(
      `  retrieval ${r.ok}/${r.n} (${pct(r.rate)}) · answer ${a.ok}/${a.n} (${pct(a.rate)})  · 版本 ${goldenDataset.dataset_version}\n`,
    );
    process.stdout.write(
      '  · gold 由 lib.mjs 独立重算；非真 LLM 语义（见 pnpm eval:semantic:live）。\n',
    );
  }

  const failed = results.filter((r) => r.status === 'FAIL');

  if (failed.length > 0) {
    process.stdout.write('\n失败详情：\n');
    for (const f of failed) {
      process.stdout.write(`  ${icon.FAIL} ${f.id} · ${f.title}\n`);
      for (const msg of f.failures) process.stdout.write(`      ${msg}\n`);
    }
  }

  process.stdout.write(`\n合计 ${summary.total} 例：`);
  process.stdout.write(
    Object.entries(summary.byStatus)
      .map(([k, v]) => `${k}=${v}`)
      .join('  '),
  );
  process.stdout.write('\n');
}

const hasFailure =
  summary.golden.ok === false ||
  results.some((r) => r.status === 'FAIL' || r.status === 'UNVERIFIED') ||
  goldenDataset.retrieval.rate < 0.9 ||
  goldenDataset.answer.rate < 0.9;
process.exit(hasFailure ? 1 : 0);
