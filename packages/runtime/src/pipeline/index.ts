/**
 * 洋葱 Pipeline（
 *
 * Harness 用「返回类型判型」（`None` vs `AsyncGenerator`）决定是否下钻。
 * TS 无法可靠 `instanceof AsyncGenerator`（打包后会变形），因此改为
 * **显式判别式联合**：`{ kind: 'middleware' | 'terminal' }`。
 *
 * 三个保留的关键语义：
 * 1. **顺序表外置**：`order` 数字 + 启动期连续性断言。
 *    漏写一个 Stage 会在启动时报错，而不是静默错序。
 * 2. **停止传播**：任一 Stage 置 `event.stopped`，后续不再执行，
 *    但已进入的 middleware 的 `finally` 仍会跑（保证 trace 落盘）。
 * 3. **前后置对称**：middleware 的 `post` 在所有内层完成后执行，
 *    正好用来统计真实 token 消耗。
 */

import type { MessageEvent } from '../platform/index.js';

export interface StageContext {
  readonly runId: string;
  readonly event: MessageEvent;
  readonly now: () => Date;
  /** 本轮可变的共享状态：各 Stage 往里写，trace 最后读。 */
  readonly state: RunState;
}

export interface MiddlewareResult {
  readonly kind: 'middleware';
  run(): AsyncGenerator<void, void, void>;
}

export interface TerminalResult {
  readonly kind: 'terminal';
  run(): Promise<void>;
}

export type StageOutcome = MiddlewareResult | TerminalResult;

export interface Stage {
  readonly name: string;
  /** 执行顺序，必须唯一且连续。 */
  readonly order: number;
  process(ctx: StageContext): StageOutcome;
}

/** 便捷构造器：把普通 async 函数包成 terminal。 */
export function terminal(fn: () => Promise<void>): TerminalResult {
  return { kind: 'terminal', run: fn };
}

/** 便捷构造器：把「前置 + 后置」包成 middleware。 */
/**
 * 便捷构造器：把「前置 → 下钻 → 后置」三段落成 middleware。
 *
 * 用法：
 * ```ts
 * middleware(async (next) => {
 *   doPre();          // 前置
 *   await next();     // 下钻：内层全部执行完才返回
 *   doPost();         // 后置
 * });
 * ```
 *
 * 实现要点：`next()` 通过一个 Promise 与生成器握手 ——
 * 生成器 `yield` 一次即代表「前置完成、可以下钻」。
 */
export function middleware(fn: (next: () => Promise<void>) => Promise<void>): MiddlewareResult {
  return {
    kind: 'middleware',
    run: async function* () {
      // 单次握手：preDone 只放行一次，避免重复推进生成器
      let releasePre!: () => void;
      const preDone = new Promise<void>((r) => {
        let done = false;
        releasePre = (): void => {
          if (done) return;
          done = true;
          r();
        };
      });

      let releaseNext!: () => void;
      const nextGate = new Promise<void>((r) => {
        let done = false;
        releaseNext = (): void => {
          if (done) return;
          done = true;
          r();
        };
      });

      const next = (): Promise<void> => {
        releasePre();
        return nextGate;
      };

      const work = fn(next).finally(releasePre);

      await preDone; // 执行到 next() 或函数结束
      yield; // ← 调度器在此递归执行后续 Stage
      releaseNext(); // 下钻回来：放行 next()
      await work;
    },
  };
}

/* ---------------------------- RunState ---------------------------- */

/**
 * 本轮的可变状态。
 *
 * 设计
 * 每个 Stage 往里写自己负责的部分，下游只读自己需要的。
 */
export interface RunState {
  // 身份
  userId: string | null;
  enterpriseId: string | null;
  accessLevel: 'read-write' | 'read-only' | 'none' | null;

  // 会话
  sessionId: string | null;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;

  // 记忆
  taskCardSummary: string | null;
  preferenceKeys: string[];

  // 上下文
  instructions: string;
  instructionsHash: string;
  appliedRules: Array<{ code: string; version: string }>;
  estimatedTokens: number;
  degradeLevel: 'L0' | 'L1' | 'L2';

  // 执行
  draft: string;
  finalText: string;
  toolResultLedger: Array<{ tool: string; path: string; value: string }>;
  writtenThisRun: Set<string>;

  // 控制
  stopped: boolean;
  stopReason: string | null;
}

export function createRunState(): RunState {
  return {
    userId: null,
    enterpriseId: null,
    accessLevel: null,
    sessionId: null,
    history: [],
    taskCardSummary: null,
    preferenceKeys: [],
    instructions: '',
    instructionsHash: '',
    appliedRules: [],
    estimatedTokens: 0,
    degradeLevel: 'L0',
    draft: '',
    finalText: '',
    toolResultLedger: [],
    writtenThisRun: new Set(),
    stopped: false,
    stopReason: null,
  };
}

/* ---------------------------- 调度器 ---------------------------- */

export class Pipeline {
  private readonly stages: Stage[];

  constructor(stages: readonly Stage[]) {
    // 启动期校验：order 必须唯一且从 1 连续
    const orders = stages.map((s) => s.order).sort((a, b) => a - b);
    for (let i = 0; i < orders.length; i++) {
      if (orders[i] !== i + 1) {
        throw new Error(
          `Pipeline Stage 顺序不连续：期望 ${i + 1}，实际 ${String(orders[i])}。` +
            `已注册：${stages.map((s) => `${s.order}:${s.name}`).join(', ')}`,
        );
      }
    }
    this.stages = [...stages].sort((a, b) => a.order - b.order);
  }

  async execute(ctx: StageContext): Promise<void> {
    await this.drive(ctx, 0);
  }

  private async drive(ctx: StageContext, from: number): Promise<void> {
    if (from >= this.stages.length || ctx.state.stopped) return;

    const stage = this.stages[from]!;
    const outcome = stage.process(ctx);

    if (outcome.kind === 'terminal') {
      await outcome.run();
      return;
    }

    // 洋葱：前置 → 下钻一次 → 后置。下钻后立即返回，由递归负责剩余 Stage。
    const gen = outcome.run();
    await gen.next(); // 推进到 yield：前置完成
    if (ctx.state.stopped) {
      await gen.return(undefined);
      return;
    }
    await this.drive(ctx, from + 1); // 下钻：执行所有内层 Stage
    await gen.next(); // 恢复：执行后置
    await gen.return(undefined); // 确保生成器收尾
  }

  list(): ReadonlyArray<{ order: number; name: string }> {
    return this.stages.map((s) => ({ order: s.order, name: s.name }));
  }
}
