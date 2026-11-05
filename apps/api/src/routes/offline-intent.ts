/**
 * 离线对话意图路由（无 LLM 时的自然语言 → 真实工具剧本）。
 *
 * 设计边界（刻意克制，不假装是 NLU）：
 * - 只识别本项目真实存在的 4 个用例工具，命中即产出一轮 tool-call；
 * - Month / 发票号 / 用途内容用确定性正则抽取，失败则结构化澄清；
 * - 识别不了的输入不硬凑工具，返回 clarify，由前端原样展示；
 * - 产出的 turns 与 /api/chat/script 完全同构，复用同一执行与 trace 链路。
 *
 * 定位澄清（赛题 C-04 / P1-2）：本文件是「未配置 LLM 时的离线降级 / 调试用途」的确定性关键词路由，
 * 不是模型理解，不用于满足赛题 C-04 的主链路，请勿据此核对 C-04 达标。
 * 主链路是配置了 HARNESS_LLM_* 的 /api/chat（走真实 createModel()，模型负责理解与决策）；
 * 离线模式仅用于零配置自测与用例回放。
 */

export interface OfflineTurn {
  readonly type: 'tool-call' | 'text';
  readonly name?: string;
  readonly args?: Record<string, unknown>;
  readonly content?: string;
}

export type OfflineRoute =
  | { readonly kind: 'run'; readonly turns: OfflineTurn[][] }
  | { readonly kind: 'clarify'; readonly message: string };

export interface OfflineContext {
  readonly enterpriseId: string;
  /** 当前活跃税期，作为未写月份时的兜底。 */
  readonly defaultMonth: string;
}

/** 月份补零宽度（'9' → '09'）/ 发票号补零宽度（'2' → 'F002'）。 */
const MONTH_WIDTH = 2;
const INVOICE_NO_WIDTH = 3;
/** 合法月份范围，以及从 fallback 税期里截取年份的长度。 */
const MIN_MONTH = 1;
const MAX_MONTH = 12;
const YEAR_LENGTH = 4;
/** 未识别输入时澄清文案里回显原文的最大长度（字符数）。 */
const UNKNOWN_TEXT_PREVIEW = 40;

/** 从「2026 年 9 月 / 2026-09 / 9 月」里抽出税期。 */
function extractMonth(text: string, fallback: string): string {
  const ym = text.match(/(20\d{2})\s*[-年/.]\s*(\d{1,2})/);
  if (ym) return `${ym[1]}-${String(Number(ym[2])).padStart(MONTH_WIDTH, '0')}`;
  const mOnly = text.match(/(\d{1,2})\s*月/);
  if (mOnly && Number(mOnly[1]) >= MIN_MONTH && Number(mOnly[1]) <= MAX_MONTH) {
    return `${fallback.slice(0, YEAR_LENGTH)}-${String(Number(mOnly[1])).padStart(MONTH_WIDTH, '0')}`;
  }
  return fallback;
}

function extractInvoiceNo(text: string): string | null {
  const m = text.match(/F\s*0?(\d{1,3})(?!\d)/i);
  return m === null ? null : `F${m[1]!.padStart(INVOICE_NO_WIDTH, '0')}`;
}

/** 抽取「用途设为 / 用途填成 / 改成 / 补为 X」里的 X。 */
function extractContent(text: string, kind: 'purpose' | 'remark'): string | null {
  const label = kind === 'purpose' ? '用途' : '备注';
  // 优先带标签的写法：用途(填成|改成|设为|写为)「内容」
  const labeled = text.match(
    new RegExp(
      `${label}\\s*(?:填成|改成|设为|设成|写为|补成|改为|填为|设置为|修改为)\\s*[「『"']?([^」』"'，。；、\\n]+)`,
    ),
  );
  if (labeled) return labeled[1]!.trim();
  // 其次：把 F00x 的用途填成「内容」/ 给 F00x 补用途「内容」
  const generic = text.match(
    /(?:填成|改成|设为|设成|写为|补成|改为|填为|设置为|修改为|补上|填上|填)\s*[「『"']?([^」』"'，。；、\n]+)/,
  );
  if (generic) return generic[1]!.trim();
  // 兜底：引号里的内容（去掉发票号本身）
  const quoted = text.match(/[「『"']([^」』"']{2,40})[」』"']/);
  if (quoted) {
    const v = quoted[1]!.trim();
    if (!/^F\s*0?\d{2,3}$/i.test(v)) return v;
  }
  return null;
}

const MONTH_HINT = /(?:金额|多少|收支|收入|支出|发票.*(?:总额|合计)|汇总|统计)/;
const GAP_HINT =
  /(?:缺项|没填|未填|空着|漏填|用途.*(?:没|未|空|漏)|哪些.*(?:要|需).*填|补全.*用途)/;
const PURPOSE_HINT = /(?:用途|purpose)/i;
const REMARK_HINT = /(?:备注|附注|remark)/i;
const WRITE_HINT = /(?:补|填|改|设|写|置|加)/;
const RULE_HINT = /(?:规则|依据|怎么算|口径|为什么|门槛)/;

export function routeOfflineIntent(text: string, ctx: OfflineContext): OfflineRoute {
  const t = text.trim();
  if (t === '') return { kind: 'clarify', message: '请输入要查询或处理的财税任务。' };

  const month = extractMonth(t, ctx.defaultMonth);
  const invoiceNo = extractInvoiceNo(t);
  const gapIntent = GAP_HINT.test(t);
  // 回写是高风险操作：必须有明确发票号才认，避免「没填用途」这类查询被误判为写入。
  const isWrite = invoiceNo !== null && !gapIntent && WRITE_HINT.test(t);

  // 1. 回写类：改用途 / 改备注（要求明确发票号 + 内容）
  if (isWrite && PURPOSE_HINT.test(t)) {
    const content = extractContent(t, 'purpose');
    if (content === null || content.length === 0) {
      return {
        kind: 'clarify',
        message: `要把 ${invoiceNo} 的用途改成什么？例如：把 F002 的用途填成「办公用品采购」。`,
      };
    }
    return {
      kind: 'run',
      turns: [
        [{ type: 'tool-call', name: 'set_invoice_purpose', args: { invoiceNo, purpose: content } }],
      ],
    };
  }
  if (isWrite && REMARK_HINT.test(t)) {
    const content = extractContent(t, 'remark');
    if (content === null || content.length === 0) {
      return {
        kind: 'clarify',
        message: `要把 ${invoiceNo} 的备注改成什么？例如：给 F002 补备注「已核对」。`,
      };
    }
    return {
      kind: 'run',
      turns: [
        [{ type: 'tool-call', name: 'set_invoice_remark', args: { invoiceNo, remark: content } }],
      ],
    };
  }

  // 2. 缺项检查（门槛陷阱）
  if (gapIntent) {
    return {
      kind: 'run',
      turns: [[{ type: 'tool-call', name: 'find_purpose_gaps', args: { month } }]],
    };
  }

  // 3. 金额统计 / 收支查询（默认只读）
  if (MONTH_HINT.test(t)) {
    return {
      kind: 'run',
      turns: [[{ type: 'tool-call', name: 'summarize_enterprise_month', args: { month } }]],
    };
  }

  // 3.5 有回写意图但缺发票号：给聚焦提示，别让用户干瞪眼。
  if (WRITE_HINT.test(t) && (PURPOSE_HINT.test(t) || REMARK_HINT.test(t))) {
    return {
      kind: 'clarify',
      message: `要修改哪张发票的${PURPOSE_HINT.test(t) ? '用途' : '备注'}？请给出发票号，例如：把 F002 的用途填成「办公用品采购」。`,
    };
  }

  // 4. 规则类问题：先给金额统计作为依据，再附说明文本
  if (RULE_HINT.test(t)) {
    return {
      kind: 'clarify',
      message:
        '离线演示模式下暂不支持自由规则问答。可试试「查 9 月金额」「查 9 月缺项」「把 F002 的用途填成办公用品采购」，或在顶部选择企业后查看「适用规则」面板。',
    };
  }

  // 5. 未识别：结构化澄清，不硬凑工具
  return {
    kind: 'clarify',
    message: `离线演示模式按关键词驱动真实用例，暂不理解「${t.slice(0, UNKNOWN_TEXT_PREVIEW)}」。可试试：\n• 甲企业 9 月发票和银行收支各是多少？\n• 9 月有哪些发票没填用途？\n• 把 F002 的用途填成「办公用品采购」`,
  };
}
