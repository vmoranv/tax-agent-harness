/**
 * 第二层：感知决策（Perceptive Decision & Risk Matrix）。
 *
 * 核心逻辑：把用户的模糊输入当成需要策略性管理的信号。
 * 综合评估 Agent 自身理解程度与行动风险后果，严格执行决策矩阵。
 *
 * 决策矩阵：
 * ┌──────────┬─────────────────────────────┬─────────────────────────────┐
 * │ 理解 × 风险│ 低风险（如只读查询）        │ 高风险（如发票回写、状态篡改）│
 * ├──────────┼─────────────────────────────┼─────────────────────────────┤
 * │ 高理解   │ 自主执行工具调用            │ 方案前置确认 / 写后强复核   │
 * ├──────────┼─────────────────────────────┼─────────────────────────────┤
 * │ 低理解   │ 声明假设并尝试执行（可撤销）│ 必须暂停，发起结构化聚焦澄清│
 * └──────────┴─────────────────────────────┴─────────────────────────────┘
 */

export type RiskLevel = 'low' | 'high';
export type UnderstandingLevel = 'high' | 'low';

export type ActionPolicy =
  | 'autonomous_execute' // 自主执行
  | 'confirm_before_execute' // 执行前确认
  | 'assume_and_execute' // 声明假设并推进
  | 'halt_and_clarify'; // 必须暂停澄清

export interface DecisionEvaluation {
  readonly understanding: UnderstandingLevel;
  readonly confidenceScore: number; // 0.0 ~ 1.0
  readonly risk: RiskLevel;
  readonly actionPolicy: ActionPolicy;
  readonly reason: string;
  readonly missingSlots: readonly string[];
}

export class DecisionMatrix {
  /**
   * 评估当前用户请求与上下文，输出感知决策行动策略。
   */
  evaluate(input: {
    text: string;
    targetIntent?: 'query' | 'modify' | 'check' | 'other';
    hasEnterprise: boolean;
    hasMonth: boolean;
    hasInvoiceTarget?: boolean;
    hasNewContent?: boolean;
  }): DecisionEvaluation {
    const isWriteAction =
      input.targetIntent === 'modify' || /(?:补|填|改|设为|设置用途|修改备注)/.test(input.text);
    const risk: RiskLevel = isWriteAction ? 'high' : 'low';

    // 评估理解置信度
    let score = 1.0;
    const missing: string[] = [];

    if (!input.hasEnterprise && !/C\d{3}|甲企业|乙企业/.test(input.text)) {
      score -= 0.35;
      missing.push('enterprise');
    }
    if (!input.hasMonth && !/\d{4}[-年]\d{1,2}/.test(input.text)) {
      score -= 0.35;
      missing.push('month');
    }

    if (isWriteAction) {
      if (!input.hasInvoiceTarget && !/F\d{3}/.test(input.text)) {
        score -= 0.4;
        missing.push('invoiceNo');
      }
      if (
        !input.hasNewContent &&
        !/(?:用途|备注)(?:为|成|是)?\s*[「“"]?([^\s"”」]+)/.test(input.text)
      ) {
        score -= 0.2;
        missing.push('content');
      }
    }

    const confidenceScore = Math.max(0, Math.min(1.0, score));
    const understanding: UnderstandingLevel = confidenceScore >= 0.7 ? 'high' : 'low';

    // 映射决策矩阵
    let actionPolicy: ActionPolicy;
    let reason: string;

    if (understanding === 'high' && risk === 'low') {
      actionPolicy = 'autonomous_execute';
      reason = '高理解低风险：主体与月份明确，执行只读汇总查询';
    } else if (understanding === 'high' && risk === 'high') {
      actionPolicy = 'confirm_before_execute';
      reason = '高理解高风险：修改发票写操作，准备写入并执行写后双向复核';
    } else if (understanding === 'low' && risk === 'low') {
      actionPolicy = 'assume_and_execute';
      reason = '低理解低风险：查询信息略有缺损，声明上下文默认假设并推进';
    } else {
      actionPolicy = 'halt_and_clarify';
      reason = `低理解高风险：缺少关键业务槽位（${missing.join('、')}），必须立即暂停并发起聚焦澄清`;
    }

    return {
      understanding,
      confidenceScore,
      risk,
      actionPolicy,
      reason,
      missingSlots: missing,
    };
  }
}
