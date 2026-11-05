/**
 * 运行事件总线（进程内）。
 *
 * SSE 路由按 runId 订阅；Harness 的 onEvent 把事件发布进来。
 * 多实例部署时换成 Redis Pub/Sub（接口相同：publish / subscribe），
 * 这是「单机演示 → 分布式」需要改的唯一一处。
 */

import { EventEmitter } from 'node:events';
import type { RunEvent } from '@harness/runtime';

class RunBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // 每个 run 的事件量很小；调高上限避免多并发误告警
    this.emitter.setMaxListeners(100);
  }

  publish(e: RunEvent): void {
    this.emitter.emit(e.runId, e);
  }

  subscribe(runId: string, handler: (e: RunEvent) => void): () => void {
    this.emitter.on(runId, handler);
    return () => this.emitter.off(runId, handler);
  }
}

export const runBus = new RunBus();
