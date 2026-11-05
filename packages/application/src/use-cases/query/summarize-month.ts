import {
  type DenialReasonDto,
  type EnterpriseDto,
  type RuleReference,
  type SummarizeMonthResult,
  toMoneyDto,
} from '@harness/contracts';
import {
  decideRead,
  type EnterpriseId,
  type Month,
  type RuleDocument,
  selectApplicableRules,
  summarizeBank,
  summarizeInvoices,
  type UserId,
} from '@harness/domain';
import type { Deps } from '../../deps.js';
import type { MonthScope } from '../common.js';

/**
 * UC-01 · 按企业 + 月份汇总发票与银行流水。
 *
 * 三个金额**分别**返回，不相互抵消（赛题 R001-2）。
 * 结果分三态：
 *   - `ok`     有记录
 *   - `empty`  有权限但该期间无记录 → 0.00（R001-6）
 *   - `denied` 无权限 → **不是 0.00**
 *
 * 权限判定**先于**任何数据查询：`none` 的拒绝不能泄漏企业是否存在。
 */
export async function summarizeMonth(deps: Deps, q: MonthScope): Promise<SummarizeMonthResult> {
  return deps.uow.run(async (tx) => {
    // ① 权限先判，不看企业是否存在
    const grant = await tx.grants.find(q.actor as UserId, q.enterpriseId as EnterpriseId);
    const read = decideRead(grant);
    if (!read.allowed) {
      return {
        kind: 'denied',
        enterpriseId: q.enterpriseId,
        reason: read.reason as DenialReasonDto,
        message: read.message,
      };
    }

    // ② 此时才有权知道企业是否存在
    const enterprise = await tx.enterprises.findById(q.enterpriseId as EnterpriseId);
    if (enterprise === null) {
      return {
        kind: 'denied',
        enterpriseId: q.enterpriseId,
        reason: 'enterprise_not_accessible',
        message: '找不到该企业，或你无权访问',
      };
    }

    const enterpriseDto: EnterpriseDto = {
      id: enterprise.id,
      fullName: enterprise.legalName,
      shortName: enterprise.aliasesFor()[0] ?? enterprise.legalName,
    };

    // ③ 取数（仓储在 SQL 层已按企业过滤）
    const [invoices, flows, candidates] = await Promise.all([
      tx.invoices.listByMonth(q.enterpriseId as EnterpriseId, q.month as Month),
      tx.banks.listByMonth(q.enterpriseId as EnterpriseId, q.month as Month),
      tx.rules.listCandidates(q.enterpriseId as EnterpriseId),
    ]);

    const invoiceSummary = summarizeInvoices(
      q.enterpriseId as EnterpriseId,
      q.month as Month,
      invoices,
    );
    const bankSummary = summarizeBank(q.enterpriseId as EnterpriseId, q.month as Month, flows);

    // ④ 规则选择用领域服务，顺序与原因都由它给出
    const selection = selectApplicableRules({
      candidates: candidates as RuleDocument[],
      scope: q.enterpriseId as EnterpriseId,
      asOfMonth: q.month as Month,
    });
    const applicableRules: RuleReference[] = selection.selected.map((c) => ({
      code: c.code,
      version: c.version,
      title: c.title,
      scope: c.scopeLabel,
      effectiveFrom: c.effectiveFrom,
      status: 'enabled',
    }));

    // ⑤ 有权限但无记录 → empty，明确说明「没有记录」而不是「0 元」
    if (invoiceSummary.outcome === 'empty' && bankSummary.outcome === 'empty') {
      return {
        kind: 'empty',
        enterprise: enterpriseDto,
        month: q.month,
        note: '该期间没有记录',
        invoice: { count: 0, total: toMoneyDto(invoiceSummary.totalInclTax) },
        bank: {
          count: 0,
          expense: toMoneyDto(bankSummary.expenseTotal),
          income: toMoneyDto(bankSummary.incomeTotal),
        },
      } satisfies SummarizeMonthResult;
    }

    return {
      kind: 'ok',
      enterprise: enterpriseDto,
      month: q.month,
      invoice: {
        count: invoiceSummary.invoiceCount,
        total: toMoneyDto(invoiceSummary.totalInclTax),
      },
      // 注意：没有 net 字段。收入与支出永远分列。
      bank: {
        count: bankSummary.incomeCount + bankSummary.expenseCount,
        expense: toMoneyDto(bankSummary.expenseTotal),
        income: toMoneyDto(bankSummary.incomeTotal),
      },
      applicableRules,
    } satisfies SummarizeMonthResult;
  });
}
