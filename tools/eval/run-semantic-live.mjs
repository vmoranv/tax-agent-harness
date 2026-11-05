#!/usr/bin/env node
/**
 * 真模型（LLM 参与评分）语义评测入口。
 *
 * 与确定性 `pnpm eval` 的本质区别：本 runner 向运行中的 API `/api/chat` 发真实
 * 自然语言问题，让**真实 LLM** 理解、决策、调工具，再用**机器断言**判定模型输出，
 * 产出 PASS/FAIL 与汇总分数。这是 Q2「LLM 参与测评」的落地。
 *
 * 诚实边界：
 *   - 真模型语义层，结果**非确定性**、依赖 apikey 与服务，**不进 `pnpm verify` / CI 阻塞**。
 *   - 不把 `/api/demo/semantic` 的 scripted 骨架当真模型；本 runner 只走 `/api/chat`。
 *   - 判据复用 `tools/demo/online-semantic.mjs` 的 L6 LIVE_CASES（4 条，从严写死）。
 *   - 未通过 = 模型语义理解缺陷（结合 /api/trace/:runId 人工复核），非链路 bug。
 *
 * 用法：
 *   pnpm eval:semantic:live                              # 默认 console（:9601）
 *   pnpm eval:semantic:live:json                        # 机器可读 JSON
 *   pnpm eval:semantic:live:report                      # Markdown 报告
 *   node tools/eval/run-semantic-live.mjs --base=http://127.0.0.1:9601
 */

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const asMarkdown = args.includes('--markdown');
const baseArg = args.find((a) => a.startsWith('--base='));
const baseFromArg = baseArg ? baseArg.slice('--base='.length).trim() : '';
const BASE = baseFromArg || process.env.HARNESS_API_BASE || 'http://127.0.0.1:9601';

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

/* --------------------------- L6 语义判据 --------------------------- */
/**
 * 与 tools/demo/online-semantic.mjs 的 LIVE_CASES 四条判据逐字一致。
 * 该脚本顶层即执行 runScripted/runLive 并 process.exit，无法作为模块导入，
 * 故在此复刻判据本体（check 函数 / 文案 / 阈值），保持与 L6 同源、判据一致。
 * check(ctx) 收 { tools(工具名数组), text, trace }，返回 { ok, reason }；判据写死、从严。
 */

/** 缺企业时一旦调用这些业务工具即判失败（T-R-02a 判据）。 */
const BIZ_TOOLS = [
  'summarize_enterprise_month',
  'find_purpose_gaps',
  'set_invoice_purpose',
  'set_invoice_remark',
];

const LIVE_CASES = Object.freeze([
  {
    id: 'T-R-01a',
    label: '换措辞·甲企业九月',
    text: '甲企业九月的发票一共多少？',
    enterpriseId: 'C001',
    check: ({ tools, text }) => ({
      ok: tools.includes('summarize_enterprise_month') && text.includes('9,622.06'),
      reason: '应调 summarize_enterprise_month 且金额 9,622.06 有溯源',
    }),
  },
  {
    id: 'T-R-01b',
    label: '换措辞·票面合计',
    text: '帮我看下甲企业 2026 年 9 月的票面合计',
    enterpriseId: 'C001',
    check: ({ tools, text }) => ({
      ok: tools.includes('summarize_enterprise_month') && text.includes('9,622.06'),
      reason: '应调 summarize_enterprise_month 且金额 9,622.06 有溯源',
    }),
  },
  {
    id: 'T-R-02a',
    label: '同句·未指定企业（应追问，不得默认企业）',
    text: '查一下金额',
    enterpriseId: 'C001',
    check: ({ tools }) => ({
      // 赛题 R1：缺企业须追问，不能擅自假设企业直接查询。
      ok: !tools.some((t) => BIZ_TOOLS.includes(t)),
      reason: '缺企业应追问而非默认 C001；调用业务查询工具即判失败',
    }),
  },
  {
    id: 'T-R-03',
    label: '多轮补充·指代消解（应追问用途内容，不得臆测写入）',
    text: '把甲企业那张复印纸的发票用途补一下',
    enterpriseId: 'C001',
    check: ({ tools, trace }) => {
      const wrote = tools.includes('set_invoice_purpose');
      const wroteWrongInvoice = (trace.toolCalls ?? []).some(
        (c) => c.name === 'set_invoice_purpose' && c.args?.invoiceNo !== 'F002',
      );
      return {
        ok: !wrote, // 未追问用途内容就写入 = 失败
        reason:
          '缺「要填的用途内容」须先追问；直接调 set_invoice_purpose 写入即判失败' +
          (wroteWrongInvoice ? '；且指代错误（复印纸应为 F002 而非所写发票）' : ''),
      };
    },
  },
]);

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

// 仅默认 console 模式打印前置信息，避免污染 --json / --markdown 的 stdout。
if (!asJson && !asMarkdown) {
  console.log(`\n=== 真模型语义评测（LLM 参与决策与评分）· ${BASE} ===`);
  console.log(`  模型：${model}（厂商：${llm.vendor ?? '未知'}）`);
  console.log('  诚实边界：结果非确定性、不进 pnpm verify / CI 阻塞；非 scripted 骨架。\n');
}

/* --------------------------- 逐条真跑 + 机器断言 --------------------------- */
const results = [];
for (const c of LIVE_CASES) {
  const base = {
    id: c.id,
    label: c.label,
    ok: false,
    reason: '',
    model,
    runId: null,
    tools: [],
    text: '',
  };
  try {
    const r = await post('/api/chat', {
      text: c.text,
      userId: 'U001',
      enterpriseId: c.enterpriseId,
    });
    const tools = (r.steps ?? []).map((s) => s.name ?? s);
    const text = r.text ?? '';
    const runId = r.runId ?? null;
    const trace = runId ? await get(`/api/trace/${encodeURIComponent(runId)}`) : {};
    const { ok, reason } = c.check({ tools, text, trace });
    results.push({ ...base, ok, reason, runId, tools, text: text.slice(0, 80) });
  } catch (e) {
    // 单条网络 / 解析异常只判该条 FAIL，记录原因，不中断整体。
    results.push({ ...base, reason: `单条异常（网络/解析）：${String(e).slice(0, 160)}` });
  }
}

/* --------------------------- 汇总 --------------------------- */
const total = results.length;
const passed = results.filter((r) => r.ok).length;
const failed = total - passed;
const rate = total === 0 ? 0 : passed / total;
const summary = {
  mode: 'real-llm-semantic (LLM participates in scoring)',
  model,
  base: BASE,
  total,
  passed,
  failed,
  rate,
  results,
};

/* --------------------------- 输出三态 --------------------------- */
/** Markdown 单元格转义：竖线与换行会破坏表格结构。 */
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

if (asJson) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else if (asMarkdown) {
  const lines = [
    '# 真模型语义评测报告（LLM 参与决策与评分）',
    '',
    `- 模型：\`${model}\` · 服务：\`${BASE}\` · 判据：L6 语义变体 ${total} 条（写死、从严）`,
    `- 结果：**${passed}/${total} 通过（${(rate * 100).toFixed(1)}%）**`,
    '',
    '| 用例 | 判据 | 结果 | 模型调用的工具 | 原因 |',
    '|---|---|---|---|---|',
  ];
  for (const r of results) {
    lines.push(
      `| ${r.id} ${cell(r.label)} | ${cell(r.reason)} | ${r.ok ? '✅ PASS' : '❌ FAIL'} | ${cell((r.tools ?? []).join(', '))} | ${cell(r.ok ? '—' : r.reason)} |`,
    );
  }
  lines.push('');
  lines.push(
    '> 诚实边界：真模型语义层，结果非确定性、依赖 apikey/服务，不进 `pnpm verify` / CI 阻塞；',
  );
  lines.push('> 未通过 = 模型语义理解缺陷（结合 /api/trace/:runId 人工复核），非链路 bug；');
  lines.push(
    '> 非 `/api/demo/semantic` 的 scripted 骨架。确定性评测见 `pnpm eval`，真模型语义亦见 `pnpm demo:semantic:live`。',
  );
  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);
} else {
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.id} ${r.label}`);
    console.log(
      `      runId=${r.runId ?? '—'} | tools=[${(r.tools ?? []).join(',')}] | text=${(r.text ?? '').slice(0, 80)}`,
    );
    if (!r.ok) console.log(`      判据：${r.reason}`);
  }
  console.log(`\n真模型语义验证：${passed}/${total} 通过（${(rate * 100).toFixed(1)}%）`);
  console.log(
    '  说明：LLM 参与决策与评分；判据按 L6 passCriteria 写死（缺企业须追问 / 缺用途内容须追问 / 指代按项目定位）。',
  );
  console.log(
    '        结果非确定性、不进 pnpm verify / CI 阻塞；未通过结合 /api/trace/:runId 人工复核。\n',
  );
}

process.exit(rate >= 0.75 ? 0 : 1);
