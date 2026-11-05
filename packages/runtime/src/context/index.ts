/**
 * 上下文装配与预算（对应赛题 R4）。
 *
 * 五段式 instructions：
 *   [身份] → [规则] → [记忆] → [能力] → [纪律]
 *
 * 两个不可裁剪的部分（R4 硬要求）：
 *   1. 规则段（含本期适用规则的名称与版本）
 *   2. 记忆段（企业、月份、未完成事项）
 *
 * 降级只有两级（评审 ADR-15）：
 *   L0 原样 → L1 按**完整轮次**从旧到新丢弃 → L2 告警但仍发送
 * 绝不在 `assistant(tool_call)` 与 `tool(result)` 之间切断。
 */

import { createHash } from 'node:crypto';

export interface RuleLine {
  readonly code: string;
  readonly title: string;
  readonly version: string;
  readonly obligationSummary: string;
}

export interface MemoryLine {
  readonly enterpriseName: string;
  readonly month: string;
  readonly pending: readonly string[];
  readonly note: string | null;
}

export interface AssembleInput {
  readonly enterpriseName: string;
  readonly accessLevel: 'read-write' | 'read-only' | 'none';
  readonly rules: readonly RuleLine[];
  readonly memory: MemoryLine | null;
  readonly preferences: readonly { key: string; value: string }[];
  readonly taskCardSummary: string | null;
  readonly history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  readonly budget: { readonly maxTokens: number };
}

export interface AssembledContext {
  readonly instructions: string;
  readonly instructionsHash: string;
  readonly history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  readonly estimatedTokens: number;
  readonly degradeLevel: 'L0' | 'L1' | 'L2';
}

/**
 * 中文友好的 token 估算。
 *
 * 不装 tiktoken：对国产模型分词器不准，还引入大依赖。
 * 经验值：汉字 ≈ 1.2 token，ASCII ≈ 0.3，其他 ≈ 0.6。
 * 有真实 usage 时以 usage 为准，估算只用于**发送前**预算判断。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x4e00 && c <= 0x9fff) cjk += 1;
    else if (c < 0x80) ascii += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 1.2 + ascii * 0.3 + other * 0.6);
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/* -------------------------- 五段式装配 -------------------------- */

function identitySection(input: AssembleInput): string {
  const permText =
    input.accessLevel === 'read-write'
      ? '可查看并修改'
      : input.accessLevel === 'read-only'
        ? '仅查看（不能修改）'
        : '无权访问';

  return [
    '你是一个财税助手，帮助用户查询企业账务数据、检查发票资料完整性、并按规定补充信息。',
    `当前企业：${input.enterpriseName}（权限：${permText}）。`,
    '你只能看到当前企业的数据。用户提到其他企业时，如实说明只有当前企业的权限。',
  ].join('\n');
}

function rulesSection(rules: readonly RuleLine[]): string {
  if (rules.length === 0) return '本期没有适用的规则。涉及规则判断时请说明资料不足。';
  const lines = rules.map((r) => `· ${r.code}《${r.title}》v${r.version}：${r.obligationSummary}`);
  return ['本期适用的规则（回答涉及规则时须注明名称与版本）：', ...lines].join('\n');
}

function memorySection(
  memory: MemoryLine | null,
  prefs: readonly { key: string; value: string }[],
): string {
  const parts: string[] = [];
  if (memory !== null) {
    parts.push(
      `当前任务：${memory.enterpriseName} ${memory.month}` +
        (memory.pending.length > 0 ? `，待办 ${memory.pending.join('、')}` : '，已完成'),
    );
    if (memory.note !== null) parts.push(`备注：${memory.note}`);
  }
  if (prefs.length > 0) {
    parts.push(`用户偏好：${prefs.map((p) => `${p.key}=${p.value}`).join('；')}`);
  }
  return parts.length === 0 ? '（暂无进行中的任务）' : parts.join('\n');
}

function capabilitySection(toolNames: readonly string[]): string {
  return `可用的工具：${toolNames.join('、')}。需要当前数据时必须调用工具，不要凭记忆回答。`;
}

function disciplineSection(): string {
  return [
    '回答要求：',
    '1. 先给结论，再给依据；不要为了完整而堆小标题。',
    '2. 回复中的金额、张数必须来自本轮工具返回的结果，不要自己计算或引用历史数字。',
    '3. 已完成 / 未完成 / 待确认分开说清楚；没做成的不要说得像做成了。',
    '4. 缺少必要信息（如月份）时直接问，一次问全，不要猜测默认值。',
    '5. 不说「作为 AI」「希望对您有帮助」这类话；不重复用户刚说过的话。',
    '6. 不要修改金额、日期、企业归属等不可改字段，只改用途和备注。',
  ].join('\n');
}

/** 按预算裁剪历史：以「完整轮次」为单位从旧到新丢弃。 */
function trimHistory(
  history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
  budgetTokens: number,
): {
  history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  level: 'L0' | 'L1' | 'L2';
} {
  const tokensOf = (h: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>): number =>
    h.reduce((n, m) => n + estimateTokens(m.content), 0);

  if (tokensOf(history) <= budgetTokens) return { history, level: 'L0' };

  // 按轮切：user 开始，到下一个 user 之前结束
  const rounds: Array<Array<{ role: 'user' | 'assistant'; content: string }>> = [];
  let cur: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of history) {
    if (m.role === 'user' && cur.length > 0) {
      rounds.push(cur);
      cur = [];
    }
    cur.push(m);
  }
  if (cur.length > 0) rounds.push(cur);

  // 从最新一轮往前累加，直到超预算
  const kept: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (let i = rounds.length - 1; i >= 0; i--) {
    const candidate = [...rounds[i]!, ...kept];
    if (tokensOf(candidate) > budgetTokens && kept.length > 0) break;
    kept.unshift(...rounds[i]!);
  }

  return { history: kept, level: kept.length === history.length ? 'L0' : 'L1' };
}

export function assembleContext(
  input: AssembleInput,
  toolNames: readonly string[],
): AssembledContext {
  const fixed = [
    identitySection(input),
    rulesSection(input.rules),
    memorySection(input.memory, input.preferences),
    capabilitySection(toolNames),
    disciplineSection(),
  ].join('\n\n');

  const fixedTokens = estimateTokens(fixed);
  const historyBudget = Math.max(0, input.budget.maxTokens - fixedTokens);

  const { history, level } = trimHistory(input.history, historyBudget);
  const historyTokens = history.reduce((n, m) => n + estimateTokens(m.content), 0);
  const total = fixedTokens + historyTokens;

  const degradeLevel: 'L0' | 'L1' | 'L2' =
    level === 'L1' ? 'L1' : total > input.budget.maxTokens ? 'L2' : 'L0';

  return {
    instructions: fixed,
    instructionsHash: sha256(fixed),
    history,
    estimatedTokens: total,
    degradeLevel,
  };
}
