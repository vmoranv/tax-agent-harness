/**
 * 第三层：结构化引导与澄清引擎（Structured Clarification & Mixed-Initiative）。
 *
 * 核心纪律：
 * 1. **Ask less**：最多提一个聚焦问题，且仅在缺少不可逆关键维度时提问。
 * 2. **State assumptions**：低风险缺口自动应用上下文合理假设并单行显式声明：
 *    "我将按 [假设] 推进，如不符请随时指出。"
 * 3. **Act on recommendation**：当选项明显最优时直接执行，不向用户抛出选择菜单。
 * 4. **问题债务 (questionDebt)**：记录会话中暂未锁定的维度，避免在多轮对话中被掩盖遗忘。
 */

import type { DecisionEvaluation } from './decision-matrix.js';

export interface ClarificationPrompt {
  readonly shouldHalt: boolean;
  readonly question?: string;
  readonly recommendedAnswer?: string;
  readonly statedAssumption?: string;
  readonly questionDebt: readonly string[];
}

export class ClarificationEngine {
  private activeDebt: Set<string> = new Set();

  /**
   * 构建结构化澄清与假设提示词。
   */
  generateClarification(
    evaluation: DecisionEvaluation,
    context: {
      defaultEnterprise?: string;
      defaultMonth?: string;
      lastMentionedInvoiceNo?: string;
    } = {},
  ): ClarificationPrompt {
    const missing = evaluation.missingSlots;

    // 记录问题债务
    for (const slot of missing) {
      this.activeDebt.add(slot);
    }

    // 1. 高风险低理解：必须强制暂停并提出单一聚焦问题
    if (evaluation.actionPolicy === 'halt_and_clarify') {
      if (missing.includes('month')) {
        return {
          shouldHalt: true,
          question: '请问需要查询或处理哪个月份的业务数据？（例如：2026-09）',
          recommendedAnswer: context.defaultMonth ?? '2026-09',
          questionDebt: [...this.activeDebt],
        };
      }
      if (missing.includes('enterprise')) {
        return {
          shouldHalt: true,
          question: '请确认需要操作的目标企业是哪一家？（甲企业 C001 还是 乙企业 C002）',
          recommendedAnswer: context.defaultEnterprise ?? '甲企业 C001',
          questionDebt: [...this.activeDebt],
        };
      }
      if (missing.includes('invoiceNo')) {
        return {
          shouldHalt: true,
          question: '请指定需要补充或修改的具体发票编号（例如 F002）。',
          recommendedAnswer: context.lastMentionedInvoiceNo ?? 'F002',
          questionDebt: [...this.activeDebt],
        };
      }
      if (missing.includes('content')) {
        return {
          shouldHalt: true,
          question: '请明确需要填入发票用途的实际业务内容（票面项目名称不能作为实际用途）。',
          questionDebt: [...this.activeDebt],
        };
      }
    }

    // 2. 低风险低理解：声明假设并推进执行（State assumptions）
    if (evaluation.actionPolicy === 'assume_and_execute') {
      const assumptions: string[] = [];
      if (missing.includes('month') && context.defaultMonth) {
        assumptions.push(`默认使用当前税期月份 ${context.defaultMonth}`);
        this.activeDebt.delete('month');
      }
      if (missing.includes('enterprise') && context.defaultEnterprise) {
        assumptions.push(`默认指定为当前授权企业 ${context.defaultEnterprise}`);
        this.activeDebt.delete('enterprise');
      }

      return {
        shouldHalt: false,
        statedAssumption:
          assumptions.length > 0
            ? `已按上下文假设【${assumptions.join('，')}】推进处理，如需调整请随时说明。`
            : undefined,
        questionDebt: [...this.activeDebt],
      };
    }

    // 3. 高理解：无债务直接推进
    return {
      shouldHalt: false,
      questionDebt: [...this.activeDebt],
    };
  }

  /**
   * 当用户明确提供了某个维度时，清偿对应的问题债务。
   */
  resolveDebt(slot: string): void {
    this.activeDebt.delete(slot);
  }

  getPendingDebt(): readonly string[] {
    return [...this.activeDebt];
  }
}
