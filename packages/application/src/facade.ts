/**
 * 应用层门面工厂（单一实现）。
 *
 * 此前 api / worker / cli 三处各写了一份几乎逐字相同的 `createApplicationFacade`，
 * 且用 `as unknown as ExplainRulesResult` 把 `explainRules` 的 `denied` 分支
 * 强转成不含 denied 的窄接口 —— 权限被拒时工具会拿到缺字段对象并误报成功。
 *
 * 这里收敛为唯一实现：
 * - 只做「参数整形」，不做业务判断（权限/金额/规则仍在用例与领域层）；
 * - `explainRules` 原样返回 `ExplainRulesOutcome`（ok | denied），由工具层
 *   在 denied 时返回 `ACCESS_DENIED` 工具失败；
 * - 放在 application 包，依赖仅 domain / contracts，不反向依赖 runtime。
 *   返回类型结构化，三个入口可直接当作 runtime 的 `ApplicationFacade` 使用。
 */
import type {
  FindPurposeGapsResult,
  SummarizeMonthResult,
  TaskCardSnapshotDto,
} from '@harness/contracts';
import type { EnterpriseId, Month, UserId } from '@harness/domain';
import type { Deps } from './deps.js';
import type { SetInvoicePurposeResult } from './use-cases/command/set-invoice-purpose.js';
import { setInvoicePurpose } from './use-cases/command/set-invoice-purpose.js';
import type { SetInvoiceRemarkResult } from './use-cases/command/set-invoice-remark.js';
import { setInvoiceRemark } from './use-cases/command/set-invoice-remark.js';
import type { ExplainRulesOutcome } from './use-cases/query/explain-rules.js';
import { explainRules } from './use-cases/query/explain-rules.js';
import { findPurposeGaps } from './use-cases/query/find-purpose-gaps.js';
import { summarizeMonth } from './use-cases/query/summarize-month.js';

/** getTaskCard 只需要一个同步的 prepare().get()，不绑定具体驱动。 */
export interface FacadeDatabase {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

export interface SetPurposeInput {
  readonly actor: UserId;
  readonly enterpriseId: EnterpriseId;
  readonly invoiceNo: string;
  readonly newPurpose: string;
  readonly runId: string;
  readonly toolCallId: string;
}

export interface SetRemarkInput {
  readonly actor: UserId;
  readonly enterpriseId: EnterpriseId;
  readonly invoiceNo: string;
  readonly newRemark: string;
  readonly runId: string;
  readonly toolCallId: string;
}

/** 与 runtime 的 ApplicationFacade 结构化一致（runtime 不依赖 application）。 */
export interface ApplicationFacadeLike {
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
  setPurpose(a: SetPurposeInput): Promise<SetInvoicePurposeResult>;
  setRemark(a: SetRemarkInput): Promise<SetInvoiceRemarkResult>;
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

/**
 * 组装应用层门面。`db` 仅用于读取 active 任务卡快照。
 * 保持三个入口（api / worker / cli）行为完全一致。
 */
export function createApplicationFacade(deps: Deps, db: FacadeDatabase): ApplicationFacadeLike {
  return {
    summarize: (q) => summarizeMonth(deps, q),
    findGaps: (q) => findPurposeGaps(deps, q),

    setPurpose: (a) =>
      setInvoicePurpose(deps, {
        actor: a.actor,
        enterpriseId: a.enterpriseId,
        invoiceNo: a.invoiceNo,
        newPurpose: a.newPurpose,
        runId: a.runId,
        toolCallId: a.toolCallId,
      }),

    setRemark: (a) =>
      setInvoiceRemark(deps, {
        actor: a.actor,
        enterpriseId: a.enterpriseId,
        invoiceNo: a.invoiceNo,
        newRemark: a.newRemark,
        runId: a.runId,
        toolCallId: a.toolCallId,
      }),

    // 不再 as unknown as：denied 分支原样返回，由工具层判定为失败。
    explainRules: (q) =>
      explainRules(deps, {
        actor: q.actor,
        enterpriseId: q.enterpriseId,
        month: q.month,
      }),

    getTaskCard: (q): Promise<TaskCardSnapshotDto | null> => {
      const row = db
        .prepare(
          `SELECT payload FROM task_card
            WHERE user_id = ? AND enterprise_id = ? AND status = 'active'`,
        )
        .get(q.actor, q.enterpriseId) as { payload: string } | undefined;
      if (row === undefined) return Promise.resolve(null);
      return Promise.resolve(JSON.parse(row.payload) as TaskCardSnapshotDto);
    },
  };
}
