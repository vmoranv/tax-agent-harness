/**
 * L7 架构约束用例：依赖方向、层次边界。
 *
 * 这些不是"风格偏好"——DDD 分层一旦被打破，
 * 领域层就会渗入 I/O，届时"程序算钱、模型说话"这条评分红线就守不住了。
 */

export const l7Cases = [
  {
    id: 'L7-DEP-01',
    title: 'domain 不依赖任何其他包',
    source: '01-architecture.md M2',
    rule: 'domain-is-pure',
    expect: 'depcruise 的 domain-is-pure 规则零违规',
  },
  {
    id: 'L7-DEP-02',
    title: 'domain 不 import Node 内置与第三方库',
    source: '01-architecture.md M2',
    rule: 'domain-no-io',
    expect: 'depcruise 的 domain-no-io 规则零违规',
  },
  {
    id: 'L7-DEP-03',
    title: 'application 不依赖 adapters 与 runtime',
    source: '01-architecture.md',
    rule: 'application-layer',
    expect: 'depcruise 的 application-layer 规则零违规',
  },
  {
    id: 'L7-DEP-04',
    title: 'runtime 不直接依赖 adapters 具体实现',
    source: '01-architecture.md',
    rule: 'runtime-no-adapters',
    expect: 'depcruise 的 runtime-no-adapters 规则零违规',
  },
  {
    id: 'L7-DEP-05',
    title: '无循环依赖',
    source: '工程约束',
    rule: 'no-circular',
    expect: 'depcruise 的 no-circular 规则零违规',
  },
  {
    id: 'L7-DEP-06',
    title: '无跨包深层 import（只能走公共出口）',
    source: '07-directory-and-conventions.md',
    rule: 'deep-import',
    expect: '源码扫描：无 @harness/xxx/src 或 /dist 深层 import',
  },
  {
    id: 'L7-DEP-07',
    title: '工具层拿不到 Repository',
    source: '01-architecture.md M2',
    rule: 'tools-cannot-reach-repositories',
    expect: 'depcruise 的 tools-cannot-reach-repositories 规则零违规',
  },
  {
    id: 'L7-DEP-08',
    title: '领域层不含 console / process 等副作用',
    source: '工程约束',
    rule: 'domain-no-io',
    expect: 'depcruise 的 domain-no-io 规则零违规（与 L7-DEP-02 同一底层约束）',
  },
];
