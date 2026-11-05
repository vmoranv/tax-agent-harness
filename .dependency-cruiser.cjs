/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment: 'domain 只能依赖自己与 zod',
      from: { path: '^packages/domain/src' },
      to: { pathNot: ['^packages/domain', 'node_modules/(zod|typescript)'] },
    },
    {
      name: 'contracts-depends-only-on-domain',
      severity: 'error',
      comment: 'contracts 只能依赖 domain 与 zod',
      from: { path: '^packages/contracts/src' },
      to: {
        pathNot: [
          '^packages/(contracts|domain)',
          'node_modules/zod',
          '^@harness/(contracts|domain)$',
        ],
      },
    },
    {
      name: 'application-layer',
      severity: 'error',
      comment: 'application 只能依赖自身、domain、contracts',
      from: { path: '^packages/application/src' },
      to: {
        pathNot: [
          '^packages/(application|domain|contracts)',
          'node_modules/zod',
          '^@harness/(application|domain|contracts)$',
        ],
      },
    },
    {
      name: 'runtime-no-adapters',
      severity: 'error',
      comment: 'runtime 不得依赖具体适配器',
      from: { path: '^packages/runtime/src' },
      to: { path: '^packages/adapters|^@harness/adapters$' },
    },
    {
      name: 'adapters-no-application',
      severity: 'error',
      comment: '适配器只实现端口，不得依赖用例层',
      from: { path: '^packages/adapters/src' },
      to: { path: '^packages/application|^@harness/application$' },
    },
    {
      name: 'plugins-no-application',
      severity: 'error',
      comment: '插件不得依赖用例层',
      from: { path: '^packages/plugins-builtin/src' },
      to: { path: '^packages/application|^@harness/application$' },
    },
    {
      name: 'tools-cannot-reach-repositories',
      severity: 'error',
      comment: '工具层只能依赖 ApplicationService，拿不到 Repository（01-architecture M2）',
      from: { path: '^packages/runtime/src/tools' },
      to: { path: '(repository|adapters/)', pathNot: '^packages/runtime/src/tools' },
    },
    {
      name: 'domain-no-io',
      severity: 'error',
      comment: 'domain 不得直接触碰 fs/网络/进程等副作用',
      from: { path: '^packages/domain' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    exclude: { path: '(dist|\\.test\\.ts$)' },
  },
};
