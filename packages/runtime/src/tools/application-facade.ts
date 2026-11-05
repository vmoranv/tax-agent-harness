/**
 * 应用层门面（面向工具层的窄接口）。
 *
 * 为什么需要它：
 * 工具要调用的用例里有 5 个，但工具**不应该**拿到整个 `ApplicationService`
 * 或任何仓储。这里只暴露「工具真正需要的那几个方法」，签名与用例一致。
 *
 * 好处：
 * - 插件作者拿到的就是这个门面，无法绕过它去碰仓储
 * - 测试可以直接实现这个接口，不需要装配整条链路
 */

import type {
  FindPurposeGapsResult,
  RuleReference,
  SummarizeMonthResult,
  TaskCardSnapshotDto,
} from '@harness/contracts';
import type { EnterpriseId, Month, UserId } from '@harness/domain';

export interface SetPurposeArgs {
  readonly actor: UserId;
  readonly enterpriseId: EnterpriseId;
  readonly invoiceNo: string;
  readonly newPurpose: string;
  readonly runId: string;
  readonly toolCallId: string;
}

export interface SetRemarkArgs {
  readonly actor: UserId;
  readonly enterpriseId: EnterpriseId;
  readonly invoiceNo: string;
  readonly newRemark: string;
  readonly runId: string;
  readonly toolCallId: string;
}

export interface SetResultLike {
  readonly kind: string;
  readonly changed?: boolean;
  readonly invoiceNo?: string;
  readonly before?: string | null;
  readonly after?: string | null;
  readonly rereadAt?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly currentVersion?: number;
  readonly expected?: string | null;
  readonly actual?: string | null;
  readonly invoiceId?: string;
}

/** 规则说明结果：ok 携带证据；denied 是权限被拒，绝不可伪装成 ok。 */
export interface ExplainRulesOk {
  readonly kind: 'ok';
  readonly applied: readonly RuleReference[];
  readonly excluded: readonly { code: string; version: string; reason: string; detail: string }[];
  readonly rationale: string;
}

export interface ExplainRulesDenied {
  readonly kind: 'denied';
  readonly reason: string;
  readonly message: string;
}

export type ExplainRulesOutcome = ExplainRulesOk | ExplainRulesDenied;

export interface ApplicationFacade {
  summarize(q: {
    actor: UserId;
    enterpriseId: EnterpriseId;
    month: Month;
  }): Promise<SummarizeMonthResult>;

  findGaps(q: {
    actor: UserId;
    enterpriseId: EnterpriseId;
    month: Month;
  }): Promise<FindPurposeGapsResult>;

  setPurpose(args: SetPurposeArgs): Promise<SetResultLike>;

  setRemark(args: SetRemarkArgs): Promise<SetResultLike>;

  explainRules(q: {
    actor: UserId;
    enterpriseId: EnterpriseId;
    month: Month;
  }): Promise<ExplainRulesOutcome>;

  getTaskCard(q: {
    actor: UserId;
    enterpriseId: EnterpriseId;
  }): Promise<TaskCardSnapshotDto | null>;
}
