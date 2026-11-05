import type { Brand } from './brand.js';
import { InvalidIdentifierError } from './domain-error.js';
import type { IsoDate } from './month.js';

/** 幂等请求标识：1..128 个 [A-Za-z0-9._:-]。 */
export type RequestId = Brand<string, 'RequestId'>;
/** 关联标识：把一次运行内的多条事件串起来。 */
export type CorrelationId = Brand<string, 'CorrelationId'>;

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function parseRequestId(raw: string): RequestId {
  if (typeof raw !== 'string' || !REQUEST_ID_RE.test(raw)) {
    throw new InvalidIdentifierError('RequestId', raw, '应为 1..128 个 [A-Za-z0-9._:-]');
  }
  return raw as RequestId;
}

export function correlationId(raw: string): CorrelationId {
  if (typeof raw !== 'string' || !REQUEST_ID_RE.test(raw)) {
    throw new InvalidIdentifierError('CorrelationId', raw, '应为 1..128 个 [A-Za-z0-9._:-]');
  }
  return raw as CorrelationId;
}

/** 领域事件的最小契约：类型 + 发生时刻。 */
export interface DomainEvent {
  readonly type: string;
  readonly occurredAt: IsoDate;
}

/** 事件信封：在领域事件外包一层投递元数据。 */
export interface EventEnvelope<E extends DomainEvent = DomainEvent> {
  readonly event: E;
  readonly correlationId: CorrelationId;
  /** 同一聚合内单调递增，用于排序与去重。 */
  readonly sequence: number;
  readonly recordedAt: IsoDate;
}
