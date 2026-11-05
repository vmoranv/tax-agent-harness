import type { SessionId } from '../conversation/conversation-session.js';
import type { Brand } from '../shared/brand.js';
import { InvalidTextError, TraceStateError } from '../shared/domain-error.js';
import type { CorrelationId } from '../shared/domain-event.js';
import type { UserId } from '../shared/ids.js';
import type { IsoDate } from '../shared/month.js';

export type RunId = Brand<string, 'RunId'>;
export type StepId = Brand<string, 'StepId'>;

export type StepKind =
  | 'user-input'
  | 'model-decision'
  | 'tool-call'
  | 'tool-result'
  | 'validation'
  | 'write'
  | 'verification'
  | 'reply'
  | 'error';

export type StepStatus = 'ok' | 'failed' | 'skipped';

export interface EvidenceRef {
  readonly kind: 'invoice' | 'bank-summary' | 'rule' | 'memory' | 'tool-result';
  readonly id: string;
}

/**
 * 脱敏策略。只保存「键名/格式」的匹配式，不保存真实密钥 ——
 * 策略本身落盘时也不能成为泄漏源。
 */
export interface RedactionPolicy {
  readonly version: string;
  readonly secretPatterns: readonly string[];
}

export interface TraceStep {
  readonly id: StepId;
  readonly seq: number;
  readonly kind: StepKind;
  readonly name: string;
  readonly status: StepStatus;
  readonly inputDigest: string | null;
  readonly outputDigest: string | null;
  readonly evidence: readonly EvidenceRef[];
  readonly durationMs: number;
  readonly errorCode: string | null;
  readonly at: IsoDate;
}

/** `append` 的入参：seq 与 id 由聚合赋值。 */
export type TraceStepInput = Omit<TraceStep, 'seq' | 'id'>;

export interface TraceRunSnapshot {
  readonly id: string;
  readonly correlationId: string;
  readonly sessionId: string | null;
  readonly userId: string;
  readonly steps: readonly TraceStep[];
  readonly status: 'running' | 'completed' | 'failed';
  readonly startedAt: IsoDate;
  readonly endedAt: IsoDate | null;
  readonly redactionVersion: string;
  readonly version: number;
}

export interface TraceRunStarted {
  readonly type: 'trace.run-started';
  readonly runId: RunId;
  readonly correlationId: CorrelationId;
  readonly userId: UserId;
  readonly sessionId: SessionId | null;
  readonly occurredAt: IsoDate;
}

export interface TraceStepRecorded {
  readonly type: 'trace.step-recorded';
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly seq: number;
  readonly kind: StepKind;
  readonly name: string;
  readonly status: StepStatus;
  readonly occurredAt: IsoDate;
}

export interface TraceRunCompleted {
  readonly type: 'trace.run-completed';
  readonly runId: RunId;
  readonly stepCount: number;
  readonly occurredAt: IsoDate;
}

export interface TraceRunFailed {
  readonly type: 'trace.run-failed';
  readonly runId: RunId;
  readonly stepCount: number;
  readonly errorCode: string;
  readonly occurredAt: IsoDate;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/i,
  /Bearer\s+[A-Za-z0-9._-]{16,}/i,
];

/**
 * 运行追踪：只追加、可回放。
 *
 * 领域层只负责结构与不变量，不落盘、不做摘要计算 ——
 * `inputDigest`/`outputDigest` 由调用方传入（已经是 sha256），
 * 领域层只校验「摘要里不能是明文密钥」。
 */
export class TraceRun {
  private constructor(
    readonly id: RunId,
    readonly correlationId: CorrelationId,
    readonly sessionId: SessionId | null,
    readonly userId: UserId,
    private stepsValue: TraceStep[],
    private statusValue: 'running' | 'completed' | 'failed',
    readonly startedAt: IsoDate,
    private endedAtValue: IsoDate | null,
    readonly redactionVersion: string,
    private versionValue: number,
  ) {}

  static start(input: {
    correlationId: CorrelationId;
    userId: UserId;
    sessionId: SessionId | null;
    redaction: RedactionPolicy;
    at: IsoDate;
  }): { run: TraceRun; event: TraceRunStarted } {
    if (input.redaction.version.trim().length === 0) {
      throw new InvalidTextError('脱敏策略必须带版本号', {});
    }
    const id = `RUN|${input.correlationId}|${input.at}` as RunId;
    const run = new TraceRun(
      id,
      input.correlationId,
      input.sessionId,
      input.userId,
      [],
      'running',
      input.at,
      null,
      input.redaction.version,
      0,
    );
    return {
      run,
      event: {
        type: 'trace.run-started',
        runId: id,
        correlationId: input.correlationId,
        userId: input.userId,
        sessionId: input.sessionId,
        occurredAt: input.at,
      },
    };
  }

  static rehydrate(s: TraceRunSnapshot): TraceRun {
    return new TraceRun(
      s.id as RunId,
      s.correlationId as CorrelationId,
      s.sessionId === null ? null : (s.sessionId as SessionId),
      s.userId as UserId,
      [...s.steps],
      s.status,
      s.startedAt,
      s.endedAt,
      s.redactionVersion,
      s.version,
    );
  }

  get status(): 'running' | 'completed' | 'failed' {
    return this.statusValue;
  }

  get steps(): readonly TraceStep[] {
    return [...this.stepsValue];
  }

  get endedAt(): IsoDate | null {
    return this.endedAtValue;
  }

  get version(): number {
    return this.versionValue;
  }

  /** 终态后追加一律拒绝：trace 是证据，不是草稿。 */
  append(step: TraceStepInput): TraceStepRecorded {
    if (this.statusValue !== 'running') {
      throw new TraceStateError(
        `运行已${this.statusValue === 'completed' ? '完成' : '失败'}，不能再追加步骤`,
        {
          runId: this.id,
          status: this.statusValue,
        },
      );
    }
    if (step.name.trim().length === 0) {
      throw new InvalidTextError('步骤名不能为空', { runId: this.id, kind: step.kind });
    }
    if (step.durationMs < 0) {
      throw new InvalidTextError('步骤耗时不能为负', {
        runId: this.id,
        durationMs: step.durationMs,
      });
    }
    for (const digest of [step.inputDigest, step.outputDigest]) {
      if (digest !== null && SECRET_PATTERNS.some((re) => re.test(digest))) {
        throw new TraceStateError('步骤摘要疑似包含密钥，拒绝写入 trace', {
          runId: this.id,
          kind: step.kind,
        });
      }
    }

    const seq = this.stepsValue.length + 1;
    const record: TraceStep = {
      ...step,
      id: `${this.id}|${seq}` as StepId,
      seq,
    };
    this.stepsValue.push(record);
    this.versionValue += 1;

    return {
      type: 'trace.step-recorded',
      runId: this.id,
      stepId: record.id,
      seq,
      kind: record.kind,
      name: record.name,
      status: record.status,
      occurredAt: record.at,
    };
  }

  complete(at: IsoDate): TraceRunCompleted {
    this.assertRunning('完成');
    this.statusValue = 'completed';
    this.endedAtValue = at;
    this.versionValue += 1;
    return {
      type: 'trace.run-completed',
      runId: this.id,
      stepCount: this.stepsValue.length,
      occurredAt: at,
    };
  }

  fail(code: string, at: IsoDate): TraceRunFailed {
    this.assertRunning('失败');
    if (code.trim().length === 0) {
      throw new InvalidTextError('失败必须给出错误码', { runId: this.id });
    }
    this.statusValue = 'failed';
    this.endedAtValue = at;
    this.versionValue += 1;
    return {
      type: 'trace.run-failed',
      runId: this.id,
      stepCount: this.stepsValue.length,
      errorCode: code,
      occurredAt: at,
    };
  }

  stepsFor(kind: StepKind): readonly TraceStep[] {
    return this.stepsValue.filter((s) => s.kind === kind);
  }

  evidenceFor(stepId: StepId): readonly EvidenceRef[] {
    const step = this.stepsValue.find((s) => s.id === stepId);
    return step === undefined ? [] : [...step.evidence];
  }

  /** 回复必须能追溯到至少一条 tool-result，否则这条 trace 不成立。 */
  hasToolEvidence(): boolean {
    return this.stepsValue.some((s) => s.kind === 'tool-result' && s.evidence.length > 0);
  }

  toSnapshot(): TraceRunSnapshot {
    return {
      id: this.id,
      correlationId: this.correlationId,
      sessionId: this.sessionId,
      userId: this.userId,
      steps: this.steps,
      status: this.statusValue,
      startedAt: this.startedAt,
      endedAt: this.endedAtValue,
      redactionVersion: this.redactionVersion,
      version: this.versionValue,
    };
  }

  private assertRunning(action: string): void {
    if (this.statusValue !== 'running') {
      throw new TraceStateError(`运行已结束，不能再次${action}`, {
        runId: this.id,
        status: this.statusValue,
      });
    }
  }
}
