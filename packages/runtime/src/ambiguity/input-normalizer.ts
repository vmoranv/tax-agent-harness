/**
 * 第一层：输入规范化（Input Normalization）。
 *
 * 核心目标：把用户带指代、省略、口语化的自然语言，在交给意图决策之前
 * 进行清洗，将「理解模糊」拆分为「语言清理」与「意图判断」两个独立子问题。
 *
 * 实现机制（参考工业实践）：
 * 1. 指代消解 (Coreference Resolution)："上一张"、"那笔发票"、"刚才那个" 绑定回上下文具体发票号
 * 2. 省略补全 (Ellipsis Completion)：根据活跃任务卡补全省略的企业简称、税期月份
 * 3. 术语标准化 (Terminology Standardization)：口语词汇对齐到财税专有名词
 * 4. 连续消息归一化 (Smooshing & Hoisting)：合并同角色碎片消息，关联工具结果
 */

export interface NormalizationContext {
  readonly activeEnterprise?: string;
  readonly activeMonth?: string;
  readonly recentInvoiceNos?: readonly string[];
  readonly lastMentionedInvoiceNo?: string;
}

export interface NormalizedInput {
  readonly originalText: string;
  readonly normalizedText: string;
  /** 识别并消解的实体映射，如 `{ '那张发票': 'F002' }` */
  readonly resolvedEntities: Readonly<Record<string, string>>;
  /** 标准化映射的术语 */
  readonly normalizedTerms: Readonly<Record<string, string>>;
  /** 补全的隐含槽位 */
  readonly completedSlots: Readonly<Record<string, string>>;
}

/** 财税常用口语到规范术语映射字典 */
const TERMINOLOGY_MAP: ReadonlyArray<[RegExp, string]> = [
  [/进账|收进来的钱|进了多少钱|进款|到账金额|项目打款/g, '银行收入'],
  [/出账|付出去的钱|转账支出|银行扣款/g, '银行支出'],
  [/含税金额|价税合计金额|发票总钱数|总面额/g, '价税合计'],
  [/没写用途|空着用途|漏填用途|缺用途/g, '用途未填写'],
  [/补充说明|附注/g, '发票备注'],
];

/** 指代词正则集合 */
const PRONOUN_PATTERNS = [
  /(?:刚才|前边|上面)(?:说的|提到的)?(?:那张|那笔)?发票/g,
  /(?:最后|最新)(?:那张|那笔)?发票/g,
  /那张发票/g,
  /这个发票/g,
  /这一张/g,
  /上一笔/g,
];

export class InputNormalizer {
  /**
   * 规范化用户输入文本。
   */
  normalize(text: string, ctx: NormalizationContext = {}): NormalizedInput {
    let current = text.trim();
    const resolvedEntities: Record<string, string> = {};
    const normalizedTerms: Record<string, string> = {};
    const completedSlots: Record<string, string> = {};

    // 1. 术语标准化
    for (const [pattern, standard] of TERMINOLOGY_MAP) {
      if (pattern.test(current)) {
        current = current.replace(pattern, (matched) => {
          normalizedTerms[matched] = standard;
          return standard;
        });
      }
    }

    // 2. 指代消解 (Coreference Resolution)
    const targetInvoice = ctx.lastMentionedInvoiceNo ?? ctx.recentInvoiceNos?.[0];
    if (targetInvoice) {
      for (const pattern of PRONOUN_PATTERNS) {
        if (pattern.test(current)) {
          current = current.replace(pattern, (matched) => {
            resolvedEntities[matched] = targetInvoice;
            return `发票 ${targetInvoice}`;
          });
        }
      }
    }

    // 3. 省略补全 (Ellipsis Completion)
    // 若用户询问金额但未明确提及月份，但上下文中有活跃月份，记录补全建议
    if (
      ctx.activeMonth &&
      /查(?:发票|银行|金额|收支)/.test(current) &&
      !/\d{4}[-年]\d{1,2}/.test(current)
    ) {
      completedSlots.month = ctx.activeMonth;
    }

    // 若用户提及发票编号但未带企业，且上下文有活跃企业，补全企业槽位
    if (ctx.activeEnterprise && /F\d{3}/.test(current) && !/C\d{3}|甲企业|乙企业/.test(current)) {
      completedSlots.enterprise = ctx.activeEnterprise;
    }

    return {
      originalText: text,
      normalizedText: current,
      resolvedEntities,
      normalizedTerms,
      completedSlots,
    };
  }

  /**
   * 连续消息合并 (Smooshing) 与工具调用关联 (Hoisting)。
   */
  smooshMessages<T extends { role: string; content: string }>(messages: readonly T[]): T[] {
    if (messages.length <= 1) return [...messages];

    const out: T[] = [];
    for (const msg of messages) {
      const last = out[out.length - 1];
      if (last && last.role === msg.role && msg.role !== 'tool') {
        // 同角色连续消息安全合并
        out[out.length - 1] = {
          ...last,
          content: `${last.content}\n${msg.content}`,
        };
      } else {
        out.push({ ...msg });
      }
    }
    return out;
  }
}
