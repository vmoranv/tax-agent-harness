/**
 * 用户模糊描述全链路优化与容错架构（四层体系）。
 *
 * 参照 `用户的模糊描述，agent怎么优化.md` 规范：
 * - Layer 1: 输入规范化 (Input Normalization) —— 指代消解、省略补全、术语标准化、连续消息合并
 * - Layer 2: 感知决策 (Perceptive Decision) —— 理解程度 × 行动风险矩阵、决策树
 * - Layer 3: 结构化引导 (Structured Clarification) —— Ask less 纪律、State assumptions、问题债务追踪
 * - Layer 4: 执行侧容错 (Execution Fault Tolerance & Saga) —— 哈希链 WAL、逆向补偿、死锁熔断
 */

export * from './causal-saga.js';
export * from './clarification-engine.js';
export * from './decision-matrix.js';
export * from './input-normalizer.js';
