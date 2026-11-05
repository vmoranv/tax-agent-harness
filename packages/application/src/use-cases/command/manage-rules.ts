import {
  type IsoDate,
  parseIsoDate,
  type RuleDocument as RuleDoc,
  RuleDocument,
  ruleCode,
  ruleVersion,
} from '@harness/domain';
import type { Deps } from '../../deps.js';

/* ------------------------------ 启用 / 停用 ------------------------------ */

export interface SetRuleStatusCommand {
  readonly code: string;
  readonly version: string;
  readonly status: 'enabled' | 'disabled';
  /** 停用必须给出原因，写进领域事件供审计。 */
  readonly reason?: string;
}

export type SetRuleStatusResult =
  | {
      readonly kind: 'updated';
      readonly code: string;
      readonly version: string;
      readonly status: string;
    }
  | { readonly kind: 'not-found'; readonly code: string; readonly version: string }
  | { readonly kind: 'invalid'; readonly message: string };

/**
 * 规则启停。
 *
 * 这是赛题 R3 的验收核心：**规则变化必须导致检查结果变化**。
 * 本用例只改状态，因果由后续的 `explainRules` / `findPurposeGaps` 体现。
 */
export async function setRuleStatus(
  deps: Deps,
  cmd: SetRuleStatusCommand,
): Promise<SetRuleStatusResult> {
  return deps.uow.run(async (tx) => {
    const code = ruleCode(cmd.code);
    const version = ruleVersion(cmd.version);

    const doc = await tx.rules.find(code, version);
    if (doc === null) {
      return { kind: 'not-found', code: cmd.code, version: cmd.version };
    }

    if (cmd.status === 'disabled' && (cmd.reason ?? '').trim().length === 0) {
      return { kind: 'invalid', message: '停用规则必须说明原因' };
    }

    const now = deps.clock.today() as IsoDate;
    const event =
      cmd.status === 'enabled' ? doc.enable(now) : doc.disable(now, cmd.reason ?? '未说明');

    await tx.rules.updateStatus(code, version, cmd.status);
    await tx.rules.save(doc);
    tx.events.publish({ ...event } as never);

    return { kind: 'updated', code: cmd.code, version: cmd.version, status: cmd.status };
  });
}

/* -------------------------------- 规则更新 -------------------------------- */

export interface UpdateRuleCommand {
  readonly code: string;
  readonly newVersion: string;
  readonly title?: string;
  readonly body?: string;
  readonly effectiveFrom: string;
  /** 新版本是否立即生效；默认 true。 */
  readonly enableNow?: boolean;
}

export type UpdateRuleResult =
  | {
      readonly kind: 'created';
      readonly code: string;
      readonly version: string;
      readonly superseded: string | null;
    }
  | { readonly kind: 'not-found'; readonly code: string }
  | { readonly kind: 'already-exists'; readonly code: string; readonly version: string };

/**
 * 规则更新：**生成新版本**，不原地改写。
 *
 * 为什么不能原地改：规则文本是判定的依据，历史结论必须可解释。
 * 如果 9 月的检查依据被 10 月的新文本覆盖，之前的回复就无法自证。
 *
 * 做法：新建 `code@newVersion`，并把同 code 的旧版本标记 `supersededBy`。
 * 旧版本保留，`selectApplicableRules` 按 `effectiveFrom` 取最新生效的那条。
 */
export async function updateRule(deps: Deps, cmd: UpdateRuleCommand): Promise<UpdateRuleResult> {
  return deps.uow.run(async (tx) => {
    const code = ruleCode(cmd.code);
    const version = ruleVersion(cmd.newVersion);

    const existingNew = await tx.rules.find(code, version);
    if (existingNew !== null) {
      return { kind: 'already-exists', code: cmd.code, version: cmd.newVersion };
    }

    const all = await tx.rules.listAll();
    const sameCode = all.filter((r) => r.code === code);
    if (sameCode.length === 0) {
      return { kind: 'not-found', code: cmd.code };
    }

    // 以最新版本为模板，继承 scope / category / obligation
    const latest = sameCode
      .slice()
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] as RuleDoc;

    const now = deps.clock.today() as IsoDate;
    const created = RuleDocument.draft({
      code,
      version,
      title: cmd.title ?? latest.title,
      category: latest.category,
      scope: latest.scope,
      effectiveFrom: parseIsoDate(cmd.effectiveFrom),
      obligation: latest.obligation,
      body: cmd.body ?? latest.body,
      supersedes: latest.version,
      updatedAt: now,
    });

    if (cmd.enableNow === false) {
      created.disable(now, '新版本创建时暂不生效');
    }

    await tx.rules.save(created);
    return {
      kind: 'created',
      code: cmd.code,
      version: cmd.newVersion,
      superseded: latest.version as string,
    };
  });
}
