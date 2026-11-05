/**
 * 数字溯源（本项目的差异化点）。
 *
 * 赛题 25% 权重在「模型与程序的边界」。前面几条机制（工具入参无结果字段、
 * 权限在领域层、写后复核）保证了**写**的正确性；这一条保证**说**的正确性。
 *
 * 做法：
 * 1. 从本轮所有工具结果里抽取「合法字面量」（金额、张数）
 * 2. 从回复草稿里抽取所有数字
 * 3. 逐个比对：不在集合内 → 标记为未溯源
 *
 * 未溯源时不一定非要删掉 —— 有些数字是用户自己说的（「F002」「9 月」）。
 * 因此只对**金额形态**（含小数）做严格校验，整数只记录不拦截。
 */

export interface LiteralEntry {
  readonly tool: string;
  readonly path: string;
  readonly value: string;
}

export interface ProvenanceCheck {
  readonly literal: string;
  readonly source: string;
  readonly ok: boolean;
}

/** 匹配金额：`9,622.06` / `1000.00` / `0.00` */
const MONEY_RE = /\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2}/g;

/** 从文本里抽金额字面量（去重、保序）。 */
export function extractMoneyLiterals(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MONEY_RE)) out.add(m[0]);
  return [...out];
}

/** 把金额规范化成无千分位的形式，便于跨格式比对。 */
function normalizeMoney(s: string): string {
  return s.replace(/,/g, '');
}

/**
 * 校验草稿中的金额是否都能在工具结果账本里找到来源。
 *
 * 返回每个字面量对应的来源；找不到时 `source = 'not-found'`、`ok = false`。
 */
export function verifyProvenance(
  draft: string,
  ledger: readonly LiteralEntry[],
): ProvenanceCheck[] {
  const known = new Map<string, LiteralEntry>();
  for (const e of ledger) {
    known.set(normalizeMoney(e.value), e);
  }

  return extractMoneyLiterals(draft).map((literal) => {
    const hit = known.get(normalizeMoney(literal));
    return hit === undefined
      ? { literal, source: 'not-found', ok: false }
      : { literal, source: `tool:${hit.tool}#${hit.path}`, ok: true };
  });
}

/** 未溯源的金额列表（用于触发一次修复或移除）。 */
export function unsourcedLiterals(checks: readonly ProvenanceCheck[]): string[] {
  return checks.filter((c) => !c.ok).map((c) => c.literal);
}

/**
 * 移除未溯源的金额。
 *
 * 用于「重试一次仍失败」的兜底：宁可少说一个数字，也不能说一个假的。
 * 保留原句结构，只把数字换成占位，避免句子碎裂。
 */
export function stripUnsourced(text: string, checks: readonly ProvenanceCheck[]): string {
  const bad = new Set(unsourcedLiterals(checks).map(normalizeMoney));
  if (bad.size === 0) return text;

  return text.replace(MONEY_RE, (m) => (bad.has(normalizeMoney(m)) ? '（数据待核对）' : m));
}
