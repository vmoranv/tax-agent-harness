/**
 * 依赖容器：把「用哪个实现」集中在一处。
 *
 * 这是装配的唯一入口 —— CLI、API、Worker 都调用它，
 * 只是传入不同配置。测试可以直接构造容器并替换任意依赖。
 */

import { openDatabase, type SqlDatabase, SqliteUnitOfWork } from '@harness/adapters';
import type { Deps } from '@harness/application';
import type { TransactionScope, UnitOfWork } from '@harness/contracts';
import type { IsoDate } from '@harness/domain';
import type { ApplicationFacade } from '@harness/runtime';

export interface Container {
  readonly uow: UnitOfWork;
  readonly deps: Deps;
  /** 供 CLI 的管理命令（trace 查询等）直接访问；业务代码不得使用。 */
  readonly db: SqlDatabase;
  readonly close: () => Promise<void>;
}

/** 时钟：可注入固定时间，便于测试。 */
export function createClock(fixed?: Date): { now: () => Date; today: () => IsoDate } {
  return {
    now: (): Date => fixed ?? new Date(),
    today: (): IsoDate => (fixed ?? new Date()).toISOString().slice(0, 10) as IsoDate,
  };
}

export function createIdGenerator(): { next: (prefix: string) => string } {
  let n = 0;
  return {
    next(prefix: string): string {
      n += 1;
      return `${prefix}_${n}`;
    },
  };
}

/** SQLite 容器（本地开发 / 测试）。 */
export function createSqliteContainer(dbPath: string): Container {
  const db = openDatabase(dbPath);
  const uow = new SqliteUnitOfWork(db);

  return {
    db,
    uow,
    deps: {
      uow,
      clock: createClock(),
      ids: createIdGenerator(),
    },
    close: async (): Promise<void> => {
      db.close();
    },
  };
}

export type { ApplicationFacade, TransactionScope };
