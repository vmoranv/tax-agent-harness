#!/usr/bin/env node
/**
 * 在线语义链路演示/验证 runner。
 *
 * 两种模式：
 *   --scripted（默认，零成本）：用脚本化模型驱动 /api/demo/semantic 走完整 Harness 链路，
 *     验证「输入规范化 → 上下文装配 → 工具循环 → 溯源 → trace」骨架与证据。
 *     ⚠️ 这是确定性剧本，证明的是链路骨架，**不是模型语义理解**。
 *   --live（需接真 apikey）：直接打 /api/chat，用 L6 语义变体集验证真实模型理解
 *     （换措辞 / 同句不同上下文 / 多轮补充），断言工具调用 + 金额 + trace 证据。
 *
 * 用法：
 *   node tools/demo/online-semantic.mjs                 # 骨架自检（默认 :9601）
 *   node tools/demo/online-semantic.mjs --live          # 真模型语义验证
 *   node tools/demo/online-semantic.mjs --base http://127.0.0.1:9601
 */
const args = process.argv.slice(2);
const live = args.includes('--live');
const baseArg = args.find((a) => a.startsWith('--base='));
const BASE = baseArg
  ? baseArg.split('=')[1]
  : (process.env['HARNESS_API_BASE'] ?? 'http://127.0.0.1:9601');

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
};
const get = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return res.json();
};

/** 骨架自检的语义变体（每个是一条不同的剧本，覆盖不同工具/链路）。 */
const SCRIPTED_CASES = [
  {
    id: 'S-01',
    label: '金额查询（规范化→规则装配→工具→溯源）',
    text: '甲企业九月的发票一共多少？',
    enterpriseId: 'C001',
    script: [
      [{ type: 'tool-call', name: 'summarize_enterprise_month', args: { month: '2026-09' } }],
      [
        {
          type: 'text',
          content:
            '甲企业 2026-09 发票价税合计 9,622.06 元；银行支出 7,180.74 元，收入 13,000.50 元。依据《金额统计说明》1.0 版。',
        },
      ],
    ],
    expectTool: 'summarize_enterprise_month',
  },
  {
    id: 'S-02',
    label: '缺项检查（版本决策 R002@2.0）',
    text: '9 月哪些发票没填用途？',
    enterpriseId: 'C001',
    script: [
      [{ type: 'tool-call', name: 'find_purpose_gaps', args: { month: '2026-09' } }],
      [{ type: 'text', content: '检查完成，缺项明细已按适用规则列出。' }],
    ],
    expectTool: 'find_purpose_gaps',
  },
  {
    id: 'S-03',
    label: '补用途写操作（read-write 权限）',
    text: '把 F002 用途填成办公用品采购',
    enterpriseId: 'C001',
    script: [
      [
        {
          type: 'tool-call',
          name: 'set_invoice_purpose',
          args: { invoiceNo: 'F002', purpose: '办公用品采购' },
        },
      ],
      [{ type: 'text', content: '已保存并重新查询确认。' }],
    ],
    expectTool: 'set_invoice_purpose',
  },
];

/**
 * L6 真模型语义变体。每个 case 用**显式断言函数**判定，判据写死，避免宽松正则自证：
 * - check(ctx) 拿到 { tools(工具名数组), text, trace } 返回 { ok, reason }。
 * - 只有「模型该做的事做对了」才算 PASS；臆测/不追问/指代错一律 FAIL 并给原因。
 */
const LIVE_CASES = [
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
      ok: !tools.some((t) =>
        [
          'summarize_enterprise_month',
          'find_purpose_gaps',
          'set_invoice_purpose',
          'set_invoice_remark',
        ].includes(t),
      ),
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
];

async function runScripted() {
  console.log(`\n=== 在线语义链路骨架自检（--scripted，零成本） · ${BASE} ===\n`);
  let pass = 0;
  for (const c of SCRIPTED_CASES) {
    const r = await post('/api/demo/semantic', {
      text: c.text,
      userId: 'U001',
      enterpriseId: c.enterpriseId,
      script: c.script,
    });
    const ev = r.evidence ?? {};
    // 链路骨架判据：工具被执行 + 被 trace 记录 + 选用的规则被装配 + 有溯源证据
    const ok =
      r.mode === 'scripted-semantic-chain' &&
      ev.toolCalls?.some((t) => t.name === c.expectTool && t.ok) &&
      ev.steps?.includes('context.assembled') &&
      ev.steps?.includes('tool.call') &&
      ev.steps?.includes('tool.result') &&
      ev.rules?.length > 0 &&
      ev.contextInstructionsLength > 0 &&
      (ev.error === null || ev.error === undefined);
    console.log(`  ${ok ? '✅' : '❌'} ${c.id} ${c.label}`);
    console.log(
      `      runId=${r.runId} | rules=[${(ev.rules ?? []).join(',')}] | toolCalls=[${(ev.toolCalls ?? []).map((t) => t.name).join(',')}] | steps=${(ev.steps ?? []).length}`,
    );
    // 拉完整 trace 证明可回溯
    const t = await get(`/api/trace/${encodeURIComponent(r.runId)}`);
    const ctx = t.context ?? {};
    console.log(
      `      trace: instructions=${ctx.instructions?.length ?? 0}字, rules=${(ctx.rules ?? []).length}, toolCalls=${(t.toolCalls ?? []).length}, provenance=${(t.provenance ?? []).length}`,
    );
    if (ok) pass += 1;
  }
  console.log(`\n骨架自检：${pass}/${SCRIPTED_CASES.length} 通过`);
  console.log('说明：这验证的是链路骨架，不是模型语义理解；真语义见 --live。\n');
  return pass === SCRIPTED_CASES.length;
}

async function runLive() {
  console.log(`\n=== 在线真模型语义验证（--live） · ${BASE} ===\n`);
  // 前置：确认真连通，排除占位假 key
  const health = await get('/health');
  const llm = health.llm ?? {};
  if (!llm.configured)
    throw new Error('未配置 LLM：请在 .env 填 HARNESS_LLM_BASE_URL / API_KEY / MODEL 并重启服务');
  if (
    /test-model|PLACEHOLDER|example\.com/i.test(
      `${llm.model ?? ''} ${process.env['HARNESS_LLM_BASE_URL'] ?? ''}`,
    )
  ) {
    console.log('  ⚠️ 检测到疑似占位模型/端点（test-model / example.com / PLACEHOLDER）。');
    console.log('     请先在 .env 填真实 HARNESS_LLM_* 并重启，否则在线请求会超时/失败。');
  }
  let pass = 0;
  for (const c of LIVE_CASES) {
    try {
      const r = await post('/api/chat', {
        text: c.text,
        userId: 'U001',
        enterpriseId: c.enterpriseId,
      });
      const tools = (r.steps ?? []).map((s) => s.name ?? s);
      const text = r.text ?? '';
      const t = await get(`/api/trace/${encodeURIComponent(r.runId)}`);
      const { ok, reason } = c.check({ tools, text, trace: t });
      console.log(`  ${ok ? '✅' : '❌'} ${c.id} ${c.label}`);
      console.log(
        `      runId=${r.runId} | tools=[${tools.join(',')}] | text=${text.slice(0, 80)}`,
      );
      console.log(
        `      trace: rules=${(t.context?.rules ?? []).length}, toolCalls=${(t.toolCalls ?? []).length}, provenance=${(t.provenance ?? []).length}`,
      );
      if (!ok) console.log(`      判据：${reason}`);
      if (ok) pass += 1;
    } catch (e) {
      console.log(`  ❌ ${c.id} ${c.label} — ${String(e).slice(0, 160)}`);
    }
  }
  console.log(`\n真模型语义验证：${pass}/${LIVE_CASES.length} 通过`);
  console.log(
    '说明：判据按 L6 passCriteria 写死（缺企业须追问 / 缺用途内容须追问 / 指代按项目定位）。',
  );
  console.log('      未通过 = 模型语义理解缺陷，非链路 bug；结合 /api/trace/:runId 人工复核。');
  console.log('      这是 L6 真模型层，结果不稳定，不进 CI 阻塞。\n');
  return pass === LIVE_CASES.length;
}

const ok = live ? await runLive() : await runScripted();
process.exit(ok ? 0 : 1);
