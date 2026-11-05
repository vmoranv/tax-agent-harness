import type { DenialReasonDto, ViewMemoryResult } from '@harness/contracts';
import {
  decideRead,
  type EnterpriseId,
  type IsoDate,
  MemoryRecord,
  memoryScope,
  type UserId,
} from '@harness/domain';
import type { Deps } from '../../deps.js';
import type { ActorContext } from '../common.js';

export interface RememberPreferenceCommand extends ActorContext {
  readonly key: string;
  readonly value: string;
}

export type RememberPreferenceResult =
  | {
      readonly kind: 'saved';
      readonly key: string;
      readonly value: string;
      readonly version: number;
    }
  | { readonly kind: 'denied'; readonly reason: DenialReasonDto; readonly message: string }
  | {
      readonly kind: 'invalid';
      readonly reason: 'empty-key' | 'too-long';
      readonly message: string;
    };

/**
 * UC-08 · 写入长期偏好（upsert 语义）。
 *
 * 同一个 key 二次写入覆盖，不产生两条记录 —— 用户的偏好是「当前值」，
 * 不是「历史流水」。历史仍可通过 `supersededBy` 链追溯。
 */
export async function rememberPreference(
  deps: Deps,
  cmd: RememberPreferenceCommand,
): Promise<RememberPreferenceResult> {
  const enterprise = cmd.enterpriseId as EnterpriseId;
  const actor = cmd.actor as UserId;

  return deps.uow.run(async (tx) => {
    const grant = await tx.grants.find(actor, enterprise);
    const read = decideRead(grant);
    if (!read.allowed) {
      return { kind: 'denied', reason: read.reason as DenialReasonDto, message: read.message };
    }

    if (cmd.key.trim().length === 0) {
      return { kind: 'invalid', reason: 'empty-key', message: '偏好名不能为空' };
    }
    if (cmd.value.trim().length > 2000) {
      return { kind: 'invalid', reason: 'too-long', message: '偏好内容不能超过 2000 字' };
    }

    const scope = memoryScope(actor, enterprise);
    const { record, event } = MemoryRecord.create({
      scope,
      kind: 'preference',
      key: cmd.key,
      value: cmd.value,
      source: { kind: 'user-stated' },
      at: deps.clock.today() as IsoDate,
    });

    await tx.preferences.upsert(record);
    tx.events.publish({ ...event } as never);

    return {
      kind: 'saved',
      key: record.key,
      value: record.value,
      version: record.version,
    };
  });
}

/* -------------------------------------------------------------------------- */

export interface ForgetMemoryCommand extends ActorContext {
  readonly key: string;
}

export type ForgetMemoryResult =
  | { readonly kind: 'deleted'; readonly key: string }
  | { readonly kind: 'not-found'; readonly key: string }
  | { readonly kind: 'denied'; readonly reason: DenialReasonDto; readonly message: string };

/**
 * UC-12 · 删除偏好。
 *
 * 幂等：删不存在的 key 返回 `not-found` 而非报错 ——
 * 「已经没有了」对用户而言是成功状态。
 */
export async function forgetMemory(
  deps: Deps,
  cmd: ForgetMemoryCommand,
): Promise<ForgetMemoryResult> {
  const enterprise = cmd.enterpriseId as EnterpriseId;
  const actor = cmd.actor as UserId;

  return deps.uow.run(async (tx) => {
    const grant = await tx.grants.find(actor, enterprise);
    const read = decideRead(grant);
    if (!read.allowed) {
      return { kind: 'denied', reason: read.reason as DenialReasonDto, message: read.message };
    }

    const deleted = await tx.preferences.delete(actor, enterprise, cmd.key);
    return deleted ? { kind: 'deleted', key: cmd.key } : { kind: 'not-found', key: cmd.key };
  });
}

/* -------------------------------------------------------------------------- */

export interface CorrectMemoryCommand extends ActorContext {
  readonly key: string;
  readonly newValue: string;
}

export type CorrectMemoryResult =
  | {
      readonly kind: 'corrected';
      readonly key: string;
      readonly value: string;
      readonly version: number;
    }
  | { readonly kind: 'not-found'; readonly key: string }
  | { readonly kind: 'denied'; readonly reason: DenialReasonDto; readonly message: string };

/**
 * UC-11 · 更正偏好。
 *
 * **不做静默 upsert**：key 不存在时必须返回 `not-found`。
 * 否则用户把「更正」说成新名字时会悄悄创建一条新偏好，
 * 旧的还在，之后两套值互相打架。
 */
export async function correctMemory(
  deps: Deps,
  cmd: CorrectMemoryCommand,
): Promise<CorrectMemoryResult> {
  const enterprise = cmd.enterpriseId as EnterpriseId;
  const actor = cmd.actor as UserId;

  return deps.uow.run(async (tx) => {
    const grant = await tx.grants.find(actor, enterprise);
    const read = decideRead(grant);
    if (!read.allowed) {
      return { kind: 'denied', reason: read.reason as DenialReasonDto, message: read.message };
    }

    const existing = await tx.preferences.find(actor, enterprise, cmd.key);
    if (existing === null) {
      return { kind: 'not-found', key: cmd.key };
    }

    const scope = memoryScope(actor, enterprise);
    const { record, event } = MemoryRecord.create({
      scope,
      kind: 'correction',
      key: cmd.key,
      value: cmd.newValue,
      source: { kind: 'user-stated' },
      at: deps.clock.today() as IsoDate,
    });

    // 更正不原地覆盖：写新记录，旧值通过 supersededBy 链可查
    await tx.preferences.upsert(record);
    tx.events.publish({ ...event } as never);

    return { kind: 'corrected', key: record.key, value: record.value, version: record.version };
  });
}

export type { ViewMemoryResult };
