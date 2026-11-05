/**
 * 第四层：执行侧容错与因果感知 Saga 协调（Causal Saga & Deadlock Breaker）。
 *
 * 核心设计（参考 agent-saga 工业架构）：
 * 1. **因果感知恢复**：严格区分「推理状态回滚」与「外部真实副作用补偿」。
 * 2. **哈希链式 WAL（写前日志）**：串联每次写入操作的前序哈希与恢复逆动作。
 * 3. **验证类工具与证据类工具二分**：
 *    - 证据类工具结果带噪音，不可直接相信其高置信度；
 *    - 验证类工具（只读复核、主键重查）提供数学确定性 Grounding。
 * 4. **死锁与发散熔断器**：
 *    - 硬步数闸门：超出步数无条件挂起并输出已完成结算报表；
 *    - 语义与调用指纹死锁检测：连续 3 次相同参数调用立即触发熔断。
 */

import { createHash } from 'node:crypto';

export interface SagaActionEntry {
  readonly actionId: string;
  readonly prevHash: string;
  readonly hash: string;
  readonly actionType: string;
  readonly target: string;
  readonly previousValue: unknown;
  readonly appliedValue: unknown;
  readonly isCompensated: boolean;
  readonly timestamp: string;
}

export class CausalSagaLedger {
  private chain: SagaActionEntry[] = [];
  private lastHash = '0000000000000000000000000000000000000000000000000000000000000000';

  /**
   * 记录一项在途或已执行的外部副作用，计算哈希链。
   */
  recordAction(entry: {
    actionId: string;
    actionType: string;
    target: string;
    previousValue: unknown;
    appliedValue: unknown;
  }): SagaActionEntry {
    const prevHash = this.lastHash;
    const raw = `${prevHash}|${entry.actionId}|${entry.actionType}|${entry.target}|${JSON.stringify(entry.appliedValue)}`;
    const hash = createHash('sha256').update(raw).digest('hex');

    const record: SagaActionEntry = {
      actionId: entry.actionId,
      prevHash,
      hash,
      actionType: entry.actionType,
      target: entry.target,
      previousValue: entry.previousValue,
      appliedValue: entry.appliedValue,
      isCompensated: false,
      timestamp: new Date().toISOString(),
    };

    this.chain.push(record);
    this.lastHash = hash;
    return record;
  }

  /**
   * 派生补偿恢复动作（Compensating Action）。
   * 逆序回滚所有未补偿的写入。
   */
  deriveCompensations(): Array<{ target: string; restoreValue: unknown }> {
    const compensations: Array<{ target: string; restoreValue: unknown }> = [];
    for (let i = this.chain.length - 1; i >= 0; i--) {
      const item = this.chain[i]!;
      if (!item.isCompensated) {
        compensations.push({
          target: item.target,
          restoreValue: item.previousValue,
        });
      }
    }
    return compensations;
  }

  getHistory(): readonly SagaActionEntry[] {
    return [...this.chain];
  }
}

/**
 * 死锁与循环发散熔断器。
 */
export class DeadlockCircuitBreaker {
  private callSignatures: string[] = [];

  /**
   * 记录一次工具调用的指纹。
   * 若检测到相同签名连续重复出现 3 次，判定为乒乓发散死锁，立即返回熔断。
   */
  checkAndRecord(name: string, args: unknown): { tripped: boolean; reason?: string } {
    const sig = `${name}:${JSON.stringify(args)}`;
    this.callSignatures.push(sig);

    const len = this.callSignatures.length;
    if (len >= 3) {
      const last1 = this.callSignatures[len - 1];
      const last2 = this.callSignatures[len - 2];
      const last3 = this.callSignatures[len - 3];
      if (last1 === last2 && last2 === last3) {
        return {
          tripped: true,
          reason: `检测到工具 ${name} 连续 3 次传入相同参数重复调用，触发死锁保护熔断机制`,
        };
      }
    }

    return { tripped: false };
  }

  reset(): void {
    this.callSignatures = [];
  }
}
