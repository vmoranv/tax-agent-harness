import type { Clock, IdGenerator, UnitOfWork } from '@harness/contracts';

/**
 * 用例的依赖注入面。
 *
 * **只有三个东西**：事务边界、时钟、ID 生成器。
 * 用例不直接持有仓储 —— 仓储只在 `uow.run(tx => ...)` 的 `tx` 里出现，
 * 从类型上保证「没有事务就拿不到数据」。
 */
export interface Deps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
