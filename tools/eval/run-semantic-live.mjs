#!/usr/bin/env node
/**
 * 真模型（LLM 参与评分）语义评测入口 —— 消费程序化生成的变体集。
 *
 * 与确定性 `pnpm eval` 的本质区别：本 runner 向运行中的 API `/api/chat` 发真实
 * 自然语言问题，让**真实 LLM** 理解、决策、调工具，再用**机器断言**判定模型输出，
 * 产出 PASS/FAIL 与按切片的通过率。评测集由 `generate-semantic.mjs` 从
 * dataset.source.json + rules.json + actors.json 独立重算 gold 生成，判据写死在
 * 本文件的 `judge()`，不生成宽松正则、不挑题凑分。
 *
 * 会话隔离（2026-11-05 修复 data leakage）：每条用例发唯一 `sessionId`，
 * 让评测请求走独立会话，避免 `session.history` 把过往轮次的正确答案喂给模型
 * （此前同 (user,enterprise) 共享 session，历史累积数百条含金额回复，模型照抄
 * 历史不调工具 → 判据与溯源防护双双 FAIL）。在线用户不传 sessionId，默认多轮不变。
 *
 * 诚实边界：
 *   - 真模型语义层，结果**非确定性**、依赖 apikey 与服务，**不进 `pnpm verify` / CI 阻塞**。
 *   - 不把 `/api/demo/semantic` 的 scripted 骨架当真模型；本 runner 只走 `/api/chat`。
 *   - 未通过 = 模型语义理解缺陷（结合 /api/trace/:runId 人工复核），非链路 bug。
 *
 * 用法：
 *   pnpm eval:semantic:live                              # 默认跑生成集（26 条）
 *   pnpm eval:semantic:live --json                       # 机器可读 JSON
 *   pnpm eval:semantic:live --markdown                   # Markdown 报告
 *   pnpm eval:semantic:live --legacy                     # 只跑旧 4 条基线（对比用）
 *   pnpm eval:semantic:live --heldout                    # held-out 泛化探针（独立冻结集，测分布外能力）
 *   node tools/eval/run-semantic-live.mjs --base=http://127.0.0.1:9601
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';
import { checkReliance } from './reliance.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const asMarkdown = args.includes('--markdown');
const legacyOnly = args.includes('--legacy');
const heldout = args.includes('--heldout');
const baseArg = args.find((a) => a.startsWith('--base='));
const baseFromArg = baseArg ? baseArg.slice('--base='.length).trim() : '';
const BASE = baseFromArg || process.env.HARNESS_API_BASE || 'http://127.0.0.1:9601';
// 每次评测运行一个独立命名空间，且每条用例一个 sessionId：彻底隔离多轮历史，
// 避免过往轮次的答案经 session.history 泄漏给模型（data leakage 修复）。
const SESSION_NS = `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/* --------------------------- HTTP 工具 --------------------------- */

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
};

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
};

/* --------------------------- 机器判据（写死） --------------------------- */

/** 业务查询工具：缺槽追问时一旦调用即判失败。 */
const BIZ_TOOLS = [
  'summarize_enterprise_month',
  'find_purpose_gaps',
  'set_invoice_purpose',
  'set_invoice_remark',
];
const WRITE_TOOLS = ['set_invoice_purpose', 'set_invoice_remark'];

/** 匹配非零金额字面量（空月回复不应出现任何非零金额）。 */
const NONZERO_MONEY_RE = /[1-9]\d{0,2}(?:,\d{3})*\.\d{2}|[1-9]\d*\.\d{2}/g;

/**
 * 按 spec.kind 分派判定。ctx = { tools(工具名数组), text, trace }。
 * 返回 { ok, reason }。判据写死、从严，不依赖模型自报。
 */
function judge(spec, { tools, text }) {
  switch (spec.kind) {
    case 'amount': {
      const ok = tools.includes(spec.expectTool) && text.includes(spec.goldInvoice);
      return {
        ok,
        reason: `应调 ${spec.expectTool} 且回复含独立 gold 金额 ${spec.goldInvoice}`,
      };
    }
    case 'split': {
      const ok =
        tools.includes(spec.expectTool) &&
        text.includes(spec.goldExpense) &&
        text.includes(spec.goldIncome) &&
        spec.goldExpense !== spec.goldIncome;
      return {
        ok,
        reason: `应调 ${spec.expectTool} 且收支分列：支出 ${spec.goldExpense}、收入 ${spec.goldIncome}（不得用净额）`,
      };
    }
    case 'empty-month': {
      // 空月：命中工具，且回复不含任何非零金额（须如实说 0 / 无记录，不能报数）。
      const nonzero = (text.match(NONZERO_MONEY_RE) ?? []).filter((m) => m !== '0.00');
      const ok = tools.includes(spec.expectTool) && nonzero.length === 0;
      return {
        ok,
        reason: `空月应命中 ${spec.expectTool} 且不报非零金额${nonzero.length ? `（实际出现 ${nonzero.join(',')}）` : ''}`,
      };
    }
    case 'rules': {
      const missing = (spec.goldCodes ?? []).filter((code) => !text.includes(code));
      const ok = tools.includes(spec.expectTool) && missing.length === 0;
      return {
        ok,
        reason: `应调 ${spec.expectTool} 且回复含 gold 规则 ${(spec.goldCodes ?? []).join(',')}${missing.length ? `（缺 ${missing.join(',')}）` : ''}`,
      };
    }
    case 'compound': {
      const missingTools = (spec.expectTools ?? []).filter((t) => !tools.includes(t));
      const ok =
        missingTools.length === 0 &&
        text.includes(spec.goldInvoice) &&
        (spec.goldCodes ?? []).every((code) => text.includes(code));
      return {
        ok,
        reason: `复合问题应命中 ${(spec.expectTools ?? []).join('+')} 且回复含金额 ${spec.goldInvoice} 与规则 ${(spec.goldCodes ?? []).join(',')}${missingTools.length ? `（缺工具 ${missingTools.join(',')}）` : ''}`,
      };
    }
    case 'no-biz-tool': {
      const hit = tools.filter((t) => BIZ_TOOLS.includes(t));
      return {
        ok: hit.length === 0,
        reason: `缺槽位须先追问，调用业务工具即失败${hit.length > 0 ? `（实际调用 ${hit.join(',')}）` : ''}`,
      };
    }
    case 'no-write': {
      const hit = tools.filter((t) => WRITE_TOOLS.includes(t));
      return {
        ok: hit.length === 0,
        reason: `缺具体内容/无权限时不得写入${hit.length > 0 ? `（实际调用 ${hit.join(',')}）` : ''}`,
      };
    }
    default:
      return { ok: false, reason: `未处理的判据类型 ${spec.kind}` };
  }
}

/* --------------------------- 用例装载 --------------------------- */

const datasetFile = heldout
  ? 'fixtures/eval/heldout-cases.json'
  : 'fixtures/eval/semantic-cases.json';
const dataset = JSON.parse(readFileSync(join(ROOT, datasetFile), 'utf8'));

/** 旧 4 条基线（用生成集的 spec 表达，供 --legacy 对比）。 */
const LEGACY = [
  {
    id: 'T-R-01a',
    slice: 'legacy-baseline',
    label: '换措辞·甲企业九月',
    text: '甲企业九月的发票一共多少？',
    userId: 'U001',
    enterpriseId: 'C001',
    spec: { kind: 'amount', expectTool: 'summarize_enterprise_month', goldInvoice: '9,622.06' },
    justification: '独立汇总 C001/2026-09 发票合计 = 9,622.06',
  },
  {
    id: 'T-R-01b',
    slice: 'legacy-baseline',
    label: '换措辞·票面合计',
    text: '帮我看下甲企业 2026 年 9 月的票面合计',
    userId: 'U001',
    enterpriseId: 'C001',
    spec: { kind: 'amount', expectTool: 'summarize_enterprise_month', goldInvoice: '9,622.06' },
    justification: '独立汇总 C001/2026-09 发票合计 = 9,622.06',
  },
  {
    id: 'T-R-02a',
    slice: 'legacy-baseline',
    label: '同句·未指定企业（应追问）',
    text: '查一下金额',
    userId: 'U001',
    enterpriseId: 'C001',
    spec: { kind: 'no-biz-tool' },
    justification: '缺企业须追问，不得默认当前企业',
  },
  {
    id: 'T-R-03',
    slice: 'legacy-baseline',
    label: '多轮补充·指代消解（应追问用途内容）',
    text: '把甲企业那张复印纸的发票用途补一下',
    userId: 'U001',
    enterpriseId: 'C001',
    spec: { kind: 'no-write' },
    justification: '缺用途内容须先追问，不得臆测写入',
  },
];

// heldout 优先于 legacy（两个 flag 独立，heldout 走独立冻结集）。
const cases = heldout ? dataset.cases : legacyOnly ? LEGACY : dataset.cases;
const casesetLabel = heldout
  ? 'held-out 泛化探针'
  : legacyOnly
    ? '旧 4 条基线'
    : `${dataset.total} 条生成变体`;

/* --------------------------- 前置自检 --------------------------- */
let health;
try {
  health = await get('/health');
} catch (e) {
  console.error(`✗ 前置自检失败：无法连接服务 ${BASE}/health — ${String(e).slice(0, 160)}`);
  console.error('  真模型语义评测需要运行中的 API 服务与已配置的 HARNESS_LLM_*。');
  process.exit(2);
}

const llm = health.llm ?? {};
if (!llm.configured) {
  console.error('✗ 前置自检失败：服务端 LLM 未配置（llm.configured=false）。');
  console.error(
    '  请在 .env 配置 HARNESS_LLM_BASE_URL / HARNESS_LLM_API_KEY / HARNESS_LLM_MODEL 并重启服务。',
  );
  console.error('  本 runner 不假装能测、不退化到 scripted 骨架。');
  process.exit(2);
}

const model = llm.model ?? '(unknown)';

if (!asJson && !asMarkdown) {
  console.log(`\n=== 真模型语义评测（LLM 参与决策与评分）· ${BASE} ===`);
  console.log(`  模型：${model}（厂商：${llm.vendor ?? '未知'}）`);
  console.log(`  评测集：${dataset.dataset_version} · ${casesetLabel}`);
  console.log('  诚实边界：结果非确定性、不进 pnpm verify / CI 阻塞；非 scripted 骨架。\n');
}

/* --------------------------- 逐条真跑 + 机器断言 --------------------------- */
// 借鉴 Mechanistic Shaping：expression(答案对) 与 reliance(依据可追溯到本轮工具结果)
// 分开度量；reliance 用已有 trace，零额外 LLM 调用。现有 ok 语义不变（历史可比）。
const results = [];
for (const c of cases) {
  const base = {
    id: c.id,
    slice: c.slice,
    label: c.label,
    ok: false, // expression：现有判据（答案/行为对不对）
    reason: '',
    model,
    runId: null,
    tools: [],
    text: '',
    reliance: 'N/A', // 'ok' | 'fail' | 'N/A'（追问/权限类不适用）
    relianceReason: '',
    reliantOk: false, // expression && reliance（"right for the right reasons"）
  };
  try {
    const r = await post('/api/chat', {
      text: c.text,
      userId: c.userId,
      enterpriseId: c.enterpriseId,
      sessionId: `${SESSION_NS}-${c.id}`,
    });
    const tools = (r.steps ?? []).map((s) => s.name ?? s);
    const text = r.text ?? '';
    const runId = r.runId ?? null;
    const { ok, reason } = judge(c.spec, { tools, text });

    // 拉本轮 trace，用工具结果做 reliance 判定（不重跑、零成本）。
    const trace = runId ? await get(`/api/trace/${encodeURIComponent(runId)}`) : {};
    const rel = checkReliance(c.spec, trace.toolCalls ?? []);
    const reliance = rel.applicable ? (rel.ok ? 'ok' : 'fail') : 'N/A';
    const reliantOk = rel.applicable ? ok && rel.ok : ok; // 追问类沿用 expression

    results.push({
      ...base,
      ok,
      reason,
      runId,
      tools,
      text: text.slice(0, 80),
      reliance,
      relianceReason: rel.reason,
      reliantOk,
    });
  } catch (e) {
    results.push({ ...base, reason: `单条异常（网络/解析）：${String(e).slice(0, 160)}` });
  }
}

/* --------------------------- 汇总（分层） --------------------------- */
const total = results.length;
const passed = results.filter((r) => r.ok).length; // expression
const failed = total - passed;
const rate = total === 0 ? 0 : passed / total;
// reliance 只统计 applicable 的数据答案类用例
const relianceApplicable = results.filter((r) => r.reliance !== 'N/A');
const reliancePass = relianceApplicable.filter((r) => r.reliance === 'ok').length;
const reliantPass = results.filter((r) => r.reliantOk).length; // expression ∧ reliance
const bySlice = {};
for (const r of results) {
  if (bySlice[r.slice] === undefined) {
    bySlice[r.slice] = {
      total: 0,
      passed: 0,
      relianceApplicable: 0,
      reliancePass: 0,
      reliantPass: 0,
    };
  }
  const s = bySlice[r.slice];
  s.total += 1;
  if (r.ok) s.passed += 1;
  if (r.reliance !== 'N/A') {
    s.relianceApplicable += 1;
    if (r.reliance === 'ok') s.reliancePass += 1;
  }
  if (r.reliantOk) s.reliantPass += 1;
}
const summary = {
  mode: 'real-llm-semantic (LLM participates in scoring)',
  model,
  base: BASE,
  dataset_version: dataset.dataset_version,
  caseset: heldout ? 'heldout' : legacyOnly ? 'legacy-4' : 'generated',
  total,
  passed, // expression（历史口径，不变）
  failed,
  rate,
  reliance: {
    applicable: relianceApplicable.length,
    passed: reliancePass,
    rate: relianceApplicable.length ? reliancePass / relianceApplicable.length : 0,
  },
  reliantPass, // expression ∧ reliance
  reliantRate: total ? reliantPass / total : 0,
  by_slice: bySlice,
  results,
};

/* --------------------------- 输出三态 --------------------------- */
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

if (asJson) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else if (asMarkdown) {
  const lines = [
    '# 真模型语义评测报告（LLM 参与决策与评分）',
    '',
    `- 模型：\`${model}\` · 服务：\`${BASE}\` · 评测集 \`${dataset.dataset_version}\`（${casesetLabel}）`,
    `- **Expression（答案对，历史口径）：${passed}/${total}（${(rate * 100).toFixed(1)}%）**`,
    `- **Reliance（依据可追溯到本轮工具结果）：${reliancePass}/${summary.reliance.applicable}（${(summary.reliance.rate * 100).toFixed(1)}%）** —— 仅数据答案类适用`,
    `- **E∧R（答对且依据对 / "right for the right reasons"）：${reliantPass}/${total}（${(summary.reliantRate * 100).toFixed(1)}%）**`,
    '',
    '| 切片 | Expression | Reliance(数据类) | E∧R |',
    '|---|---|---|---|',
  ];
  for (const [s, v] of Object.entries(bySlice)) {
    lines.push(
      `| ${s} | ${v.passed}/${v.total} | ${v.reliancePass}/${v.relianceApplicable} | ${v.reliantPass}/${v.total} |`,
    );
  }
  lines.push(
    '',
    '| 用例 | 切片 | Expression | Reliance | 工具 | 判据 |',
    '|---|---|---|---|---|---|',
  );
  for (const r of results) {
    const relTag = r.reliance === 'N/A' ? '—' : r.reliance === 'ok' ? '✅ 依据对' : '⚠️ 依据缺';
    lines.push(
      `| ${r.id} ${cell(r.label)} | ${r.slice} | ${r.ok ? '✅' : '❌'} | ${relTag} | ${cell((r.tools ?? []).join(', '))} | ${cell(r.reason)} |`,
    );
  }
  lines.push('');
  lines.push(
    '> 借鉴 Mechanistic Shaping 的 expression ≠ reliance 理念：白盒激活不可得，黑盒等价证据是',
  );
  lines.push(
    '> `trace.toolCalls[].result`；reliance 用已有 trace 判定、零额外 LLM 调用。`ok` 语义不变（历史可比）。',
  );
  lines.push(
    '> 诚实边界：真模型语义层非确定性、不进 verify/CI；未通过需结合 /api/trace/:runId 复核；',
  );
  lines.push('> gold 由 lib.mjs 独立重算、判据写死，非 scripted 骨架、非挑题凑分。');
  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);
} else {
  for (const [s, v] of Object.entries(bySlice)) {
    console.log(
      `  ${s.padEnd(22)} E ${v.passed}/${v.total}  R ${v.reliancePass}/${v.relianceApplicable}  E∧R ${v.reliantPass}/${v.total}`,
    );
  }
  console.log('');
  for (const r of results) {
    if (r.ok && r.reliance !== 'fail') continue;
    console.log(`  ${r.ok ? '❌' : '❌'} ${r.id} [${r.slice}] ${r.label}`);
    console.log(`      tools=[${(r.tools ?? []).join(',')}] | reliance=${r.reliance}`);
    if (!r.ok) console.log(`      判据：${r.reason}`);
    if (r.reliance === 'fail') console.log(`      reliance：${r.relianceReason}`);
  }
  console.log(`\nExpression（答案对）：${passed}/${total}（${(rate * 100).toFixed(1)}%）`);
  console.log(
    `Reliance（依据可追溯到本轮工具）：${reliancePass}/${summary.reliance.applicable}（${(summary.reliance.rate * 100).toFixed(1)}%，仅数据答案类）`,
  );
  console.log(
    `E∧R（答对且依据对）：${reliantPass}/${total}（${(summary.reliantRate * 100).toFixed(1)}%）`,
  );
  console.log(
    '  说明：借鉴 expression≠reliance；reliance 用已有 trace、零额外 LLM；ok 语义不变。\n',
  );
}

process.exit(rate >= 0.75 ? 0 : 1);
