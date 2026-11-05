import type { AccessDecision } from '../identity/access-policy.js';
import type { RuleCitation } from '../rulebook/rule-selection.js';
import type { Brand } from '../shared/brand.js';
import { InvalidTextError, SessionStateError } from '../shared/domain-error.js';
import type { EnterpriseId, UserId } from '../shared/ids.js';
import type { IsoDate } from '../shared/month.js';

export type SessionId = Brand<string, 'SessionId'>;
export type TurnId = Brand<string, 'TurnId'>;

export function sessionId(raw: string): SessionId {
  if (raw.trim().length === 0) throw new InvalidTextError('会话 id 不能为空', { raw });
  return raw as SessionId;
}

export type Intent =
  | 'query-summary'
  | 'query-rules'
  | 'check-missing'
  | 'fill-purpose'
  | 'correct-memory'
  | 'switch-enterprise'
  | 'resume-task'
  | 'smalltalk'
  | 'unknown';

export type SlotName = 'enterprise' | 'month' | 'invoiceNo' | 'purpose' | 'field' | 'confirmation';

export interface SlotState {
  readonly name: SlotName;
  readonly value: string | null;
  readonly source: 'user' | 'memory' | 'inferred' | 'missing';
}

export type ClarificationReason =
  | 'missing-month'
  | 'missing-enterprise'
  | 'ambiguous-enterprise'
  | 'missing-invoice'
  | 'missing-value'
  | 'confirm-write';

export interface Clarification {
  readonly reason: ClarificationReason;
  readonly slots: readonly SlotName[];
  readonly question: string;
}

/** 模型提出的工具调用；`resultRef` 指向 trace 步骤，便于数字回查。 */
export interface ToolInvocation {
  readonly name: string;
  readonly args: Readonly<Record<string, string | number | boolean | null>>;
  readonly resultRef: string;
}

export interface ModelDecision {
  readonly intent: Intent;
  readonly slots: readonly SlotState[];
  readonly toolCalls: readonly ToolInvocation[];
  readonly replyDraft: string;
  readonly citedRuleIds: readonly string[];
}

/** 通过 DecisionValidator 的决策：数字与引用都有证据。 */
export interface ValidatedDecision {
  readonly decision: ModelDecision;
  readonly numericClaims: readonly { readonly raw: string; readonly evidenceRef: string }[];
  readonly citations: readonly RuleCitation[];
}

export interface Turn {
  readonly id: TurnId;
  readonly index: number;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly text: string;
  readonly intent: Intent | null;
  readonly decision: ModelDecision | null;
  readonly at: IsoDate;
}

export interface ConversationSessionSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly activeEnterprise: EnterpriseId | null;
  readonly turns: readonly Turn[];
  readonly pending: Clarification | null;
  readonly startedAt: IsoDate;
  readonly updatedAt: IsoDate;
  readonly version: number;
}

export interface SessionStarted {
  readonly type: 'conversation.session-started';
  readonly sessionId: SessionId;
  readonly userId: UserId;
  readonly occurredAt: IsoDate;
}

export interface TurnRecorded {
  readonly type: 'conversation.turn-recorded';
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly index: number;
  readonly role: Turn['role'];
  readonly intent: Intent | null;
  readonly occurredAt: IsoDate;
}

export interface ClarificationRequested {
  readonly type: 'conversation.clarification-requested';
  readonly sessionId: SessionId;
  readonly reason: ClarificationReason;
  readonly slots: readonly SlotName[];
  readonly occurredAt: IsoDate;
}

export interface ClarificationResolved {
  readonly type: 'conversation.clarification-resolved';
  readonly sessionId: SessionId;
  readonly slot: SlotName;
  readonly value: string;
  readonly occurredAt: IsoDate;
}

export interface EnterpriseSwitched {
  readonly type: 'conversation.enterprise-switched';
  readonly sessionId: SessionId;
  readonly from: EnterpriseId | null;
  readonly to: EnterpriseId;
  readonly occurredAt: IsoDate;
}

/**
 * 会话：轮次只追加，身份不可由文本更改。
 *
 * 三条硬约束：
 * ① `userId` 创建后不可变，任何「我是别的主管」类文本都不改动它；
 * ② 切换企业必须携带 `allowed === true` 的访问决策，否则拒绝；
 * ③ 有未解决的澄清时不得跳步执行新任务 —— 缺的月份没补上就查数，
 *    等于拿默认月份编答案。
 */
export class ConversationSession {
  private constructor(
    readonly id: SessionId,
    readonly userId: UserId,
    private activeEnterpriseValue: EnterpriseId | null,
    private turnsValue: Turn[],
    private pendingValue: Clarification | null,
    readonly startedAt: IsoDate,
    private updatedAtValue: IsoDate,
    private versionValue: number,
  ) {}

  static start(
    userId: UserId,
    at: IsoDate,
  ): { session: ConversationSession; event: SessionStarted } {
    const id = `S|${userId}|${at}` as SessionId;
    const session = new ConversationSession(id, userId, null, [], null, at, at, 0);
    return {
      session,
      event: {
        type: 'conversation.session-started',
        sessionId: id,
        userId,
        occurredAt: at,
      },
    };
  }

  static rehydrate(s: ConversationSessionSnapshot): ConversationSession {
    return new ConversationSession(
      s.id as SessionId,
      s.userId as UserId,
      s.activeEnterprise,
      [...s.turns],
      s.pending,
      s.startedAt,
      s.updatedAt,
      s.version,
    );
  }

  get pendingClarification(): Clarification | null {
    return this.pendingValue;
  }

  get currentEnterprise(): EnterpriseId | null {
    return this.activeEnterpriseValue;
  }

  get turns(): readonly Turn[] {
    return [...this.turnsValue];
  }

  get version(): number {
    return this.versionValue;
  }

  get updatedAt(): IsoDate {
    return this.updatedAtValue;
  }

  recordUserTurn(text: string, at: IsoDate): TurnRecorded {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new InvalidTextError('用户消息不能为空', { sessionId: this.id });
    }
    return this.appendTurn('user', trimmed, null, null, at);
  }

  /**
   * 记录助手轮次。入参是 `ValidatedDecision`，类型层面就要求已通过
   * `DecisionValidator` —— 未校验的 `ModelDecision` 无法直接塞进来。
   */
  recordAssistantTurn(v: ValidatedDecision, at: IsoDate): TurnRecorded {
    if (v.numericClaims.some((c) => c.evidenceRef.trim().length === 0)) {
      throw new SessionStateError('助手回复中的数字缺少证据引用', { sessionId: this.id });
    }
    const intent = v.decision.intent;
    return this.appendTurn('assistant', v.decision.replyDraft, intent, v.decision, at);
  }

  requestClarification(c: Clarification, at: IsoDate): ClarificationRequested {
    if (c.question.trim().length === 0) {
      throw new InvalidTextError('澄清问题不能为空', { sessionId: this.id });
    }
    if (c.slots.length === 0) {
      throw new InvalidTextError('澄清必须指明缺失的槽位', { sessionId: this.id });
    }
    this.pendingValue = c;
    this.versionValue += 1;
    this.updatedAtValue = at;
    return {
      type: 'conversation.clarification-requested',
      sessionId: this.id,
      reason: c.reason,
      slots: c.slots,
      occurredAt: at,
    };
  }

  /** 补齐一个槽位；补齐后若无剩余缺失槽位则清除待澄清状态。 */
  resolveClarification(slot: SlotName, value: string, at: IsoDate): ClarificationResolved {
    if (this.pendingValue === null) {
      throw new SessionStateError('当前没有待澄清的问题', { sessionId: this.id, slot });
    }
    if (!this.pendingValue.slots.includes(slot)) {
      throw new SessionStateError('该槽位不在当前澄清问题范围内', {
        sessionId: this.id,
        slot,
        expected: this.pendingValue.slots,
      });
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new InvalidTextError('补齐的值不能为空', { sessionId: this.id, slot });
    }
    this.pendingValue = null;
    this.versionValue += 1;
    this.updatedAtValue = at;
    return {
      type: 'conversation.clarification-resolved',
      sessionId: this.id,
      slot,
      value: trimmed,
      occurredAt: at,
    };
  }

  /**
   * 切换企业。`decision.allowed === false` 一律拒绝 ——
   * 而且要拒绝得和「企业不存在」完全一致，不能泄漏存在性。
   */
  switchEnterprise(next: EnterpriseId, decision: AccessDecision, at: IsoDate): EnterpriseSwitched {
    if (!decision.allowed) {
      throw new SessionStateError(`不能切换到该企业：${decision.message}`, {
        sessionId: this.id,
        reason: decision.reason,
      });
    }
    if (this.pendingValue !== null) {
      throw new SessionStateError('有待澄清的问题未解决，不能切换企业', {
        sessionId: this.id,
        reason: this.pendingValue.reason,
      });
    }
    const from = this.activeEnterpriseValue;
    this.activeEnterpriseValue = next;
    this.versionValue += 1;
    this.updatedAtValue = at;
    return {
      type: 'conversation.enterprise-switched',
      sessionId: this.id,
      from,
      to: next,
      occurredAt: at,
    };
  }

  toSnapshot(): ConversationSessionSnapshot {
    return {
      id: this.id,
      userId: this.userId,
      activeEnterprise: this.activeEnterpriseValue,
      turns: this.turns,
      pending: this.pendingValue,
      startedAt: this.startedAt,
      updatedAt: this.updatedAtValue,
      version: this.versionValue,
    };
  }

  private appendTurn(
    role: Turn['role'],
    text: string,
    intent: Intent | null,
    decision: ModelDecision | null,
    at: IsoDate,
  ): TurnRecorded {
    const index = this.turnsValue.length;
    const turn: Turn = {
      id: `${this.id}|${index}` as TurnId,
      index,
      role,
      text,
      intent,
      decision,
      at,
    };
    this.turnsValue.push(turn);
    this.versionValue += 1;
    this.updatedAtValue = at;
    return {
      type: 'conversation.turn-recorded',
      sessionId: this.id,
      turnId: turn.id,
      index,
      role,
      intent,
      occurredAt: at,
    };
  }
}
