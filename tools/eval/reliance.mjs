/**
 * Reliance 监控（评测层）—— 借鉴 Mechanistic Shaping 论文的
 * 「expression ≠ reliance / right for the right reasons」理念在黑盒 API 上的等价落点。
 *
 * 论文白盒做法：用内部激活/attribution 约束模型「依赖什么概念做决策」。
 * 本 harness 只有 OpenAI-compatible 黑盒 API，拿不到激活/权重；等价的
 * 「relied-on evidence」是**本轮工具调用的结构化结果**（trace.toolCalls[].result）。
 *
 * 判据（写死、机器可判）：
 *   expression = 现有 judge(tools, text)：答案文本是否含独立 gold 金额。
 *   reliance   = 回复里的 gold 金额/支出/收入，必须能在**本轮成功工具结果**里
 *                逐字找到；否则视为「凭记忆蒙对 / 引用历史数字 / 未真正调用取数」。
 *   reliantOk  = expression && reliance（论文「right for the right reasons」的近似）。
 *
 * 与运行时 provenance（stripUnsourced 编辑回复）互补：那是防护、这是度量，
 * 不重复实现、互不改动。只用已有 trace，零额外 LLM 调用。
 */

/** 匹配金额：`9,622.06` / `1000.00` / `0.00`（与 runtime/provenance 同口径）。 */
const MONEY_RE = /\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2}/g;

/** 递归收集对象里所有字符串值，用于从中抽金额字面量。 */
function collectStrings(value, out) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

/** 从本轮成功工具结果里抽取所有金额字面量（去重）。 */
export function evidenceLiterals(toolCalls) {
  const strings = [];
  for (const call of toolCalls ?? []) {
    if (call.ok !== true) continue;
    collectStrings(call.result, strings);
  }
  const set = new Set();
  for (const s of strings) {
    for (const m of s.matchAll(MONEY_RE)) set.add(m[0]);
  }
  return set;
}

/** 金额规范化（去千分位），便于跨格式比对。 */
function norm(s) {
  return s.replace(/,/g, '');
}

/**
 * 判定单条用例的 reliance。
 * @returns {{ applicable: boolean, ok: boolean, reason: string }}
 *   applicable=false 表示该用例是「追问/权限」类，没有数据答案，reliance 不适用。
 */
export function checkReliance(spec, toolCalls) {
  // 只有「数据答案」类用例才谈 reliance；追问/权限类返回不适用。
  if (spec.kind !== 'amount' && spec.kind !== 'split') {
    return { applicable: false, ok: false, reason: '追问/权限类无数据答案，reliance 不适用' };
  }

  const evidence = evidenceLiterals(toolCalls);
  const normEvidence = new Set([...evidence].map(norm));
  const required =
    spec.kind === 'amount' ? [spec.goldInvoice] : [spec.goldExpense, spec.goldIncome];

  const missing = required.filter((v) => v !== undefined && !normEvidence.has(norm(String(v))));
  return {
    applicable: true,
    ok: missing.length === 0,
    reason:
      missing.length === 0
        ? `gold ${required.join(' / ')} 全部可追溯到本轮 ${evidence.size} 个工具结果金额`
        : `gold ${missing.join(' / ')} 未出现在本轮工具结果（疑似凭记忆/历史数字），证据金额=[${[...evidence].join(', ')}]`,
  };
}
