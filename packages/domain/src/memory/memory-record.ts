import { InvalidTextError } from '../shared/domain-error.js';
import type { IsoDate } from '../shared/month.js';
import type { MemoryScope } from './memory-scope.js';

export type MemoryKind = 'profile' | 'preference' | 'correction' | 'fact';

export interface MemorySource {
  readonly kind: 'user-stated' | 'tool-result' | 'system';
  readonly ref?: string;
}

export interface MemoryRecordSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly enterpriseId: string;
  readonly kind: MemoryKind;
  readonly key: string;
  readonly value: string;
  readonly version: number;
  readonly supersededBy: string | null;
  readonly source: MemorySource;
  readonly createdAt: IsoDate;
  readonly updatedAt: IsoDate;
}

export interface MemoryRecordWritten {
  readonly type: 'memory.record-written';
  readonly recordId: string;
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly key: string;
  readonly version: number;
  readonly occurredAt: IsoDate;
}

export interface MemoryRecordSuperseded {
  readonly type: 'memory.record-superseded';
  readonly recordId: string;
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly key: string;
  readonly version: number;
  readonly occurredAt: IsoDate;
}

const KINDS: readonly MemoryKind[] = ['profile', 'preference', 'correction', 'fact'];
const MAX_VALUE = 2000;

/**
 * 长期记忆条目。
 *
 * 更正不原地覆盖：写入新记录并把旧记录的 `supersededBy` 指向新 id，
 * 这样「用户上次说的是什么」始终可查，也能在回复里解释为什么改了。
 */
export class MemoryRecord {
  private constructor(
    readonly id: string,
    readonly scope: MemoryScope,
    readonly kind: MemoryKind,
    readonly key: string,
    private valueValue: string,
    readonly version: number,
    private supersededByValue: string | null,
    readonly source: MemorySource,
    readonly createdAt: IsoDate,
    private updatedAtValue: IsoDate,
  ) {}

  static create(input: {
    scope: MemoryScope;
    kind: MemoryKind;
    key: string;
    value: string;
    source: MemorySource;
    at: IsoDate;
  }): { record: MemoryRecord; event: MemoryRecordWritten } {
    if (!KINDS.includes(input.kind)) {
      throw new InvalidTextError(`未知的记忆类型: ${String(input.kind)}`, { kind: input.kind });
    }
    const key = input.key.trim();
    if (key.length === 0) {
      throw new InvalidTextError('记忆键不能为空', { kind: input.kind });
    }
    const value = input.value.trim();
    if (value.length > MAX_VALUE) {
      throw new InvalidTextError(`记忆内容不能超过 ${MAX_VALUE} 字`, { length: value.length });
    }
    const id = `${input.scope.userId}|${input.scope.enterpriseId}|${input.kind}|${key}|v1`;
    const record = new MemoryRecord(
      id,
      input.scope,
      input.kind,
      key,
      value,
      1,
      null,
      input.source,
      input.at,
      input.at,
    );
    return {
      record,
      event: {
        type: 'memory.record-written',
        recordId: id,
        scope: input.scope,
        kind: input.kind,
        key,
        version: 1,
        occurredAt: input.at,
      },
    };
  }

  static rehydrate(s: MemoryRecordSnapshot): MemoryRecord {
    return new MemoryRecord(
      s.id,
      { userId: s.userId, enterpriseId: s.enterpriseId } as MemoryScope,
      s.kind,
      s.key,
      s.value,
      s.version,
      s.supersededBy,
      s.source,
      s.createdAt,
      s.updatedAt,
    );
  }

  get value(): string {
    return this.valueValue;
  }

  get supersededBy(): string | null {
    return this.supersededByValue;
  }

  get updatedAt(): IsoDate {
    return this.updatedAtValue;
  }

  /** 仅未失效的记录参与召回。 */
  isActive(): boolean {
    return this.supersededByValue === null;
  }

  supersede(nextId: string, at: IsoDate): MemoryRecordSuperseded {
    if (nextId.trim().length === 0) {
      throw new InvalidTextError('后继记忆记录的 id 不能为空', { recordId: this.id });
    }
    if (nextId === this.id) {
      throw new InvalidTextError('记忆记录不能指向自身作为后继', { recordId: this.id });
    }
    this.supersededByValue = nextId;
    this.updatedAtValue = at;
    return {
      type: 'memory.record-superseded',
      recordId: this.id,
      scope: this.scope,
      kind: this.kind,
      key: this.key,
      version: this.version,
      occurredAt: at,
    };
  }

  toSnapshot(): MemoryRecordSnapshot {
    return {
      id: this.id,
      userId: this.scope.userId,
      enterpriseId: this.scope.enterpriseId,
      kind: this.kind,
      key: this.key,
      value: this.valueValue,
      version: this.version,
      supersededBy: this.supersededByValue,
      source: this.source,
      createdAt: this.createdAt,
      updatedAt: this.updatedAtValue,
    };
  }
}
