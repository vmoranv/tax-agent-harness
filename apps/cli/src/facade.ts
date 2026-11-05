/**
 * CLI 侧应用层门面：唯一实现收敛在 `@harness/application`。
 * `createFacade` 是 CLI 历史命名，保留为别名以维持 `bootstrap.ts` 的 import 不变。
 */
export { createApplicationFacade as createFacade } from '@harness/application';
