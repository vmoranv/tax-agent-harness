/**
 * `@harness/contracts` 公共出口。
 *
 * 本包只有**接口、类型、纯数据转换与零逻辑注册表**，不含任何 I/O。
 * `adapters` 与 `plugins` 通过本包实现扩展点，因此它们永远拿不到
 * `@harness/application` —— 这是「插件不能绕过业务校验」的物理保证。
 */

export * from './dto/index.js';
export * from './errors/index.js';
export * from './plugin/index.js';
export * from './ports/index.js';
