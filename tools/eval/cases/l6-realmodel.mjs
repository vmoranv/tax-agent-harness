/**
 * L6 端到端（真模型）用例：手工执行，用于演示前验证。
 *
 * 为什么单列一层：假模型验证的是「程序骨架」，真模型验证的是
 * 「模型理解能力」。赛题 R1 明确要求「同一句话在不同上下文产生不同动作」，
 * 这条只能在真模型上验，且结果不稳定，所以不进 CI。
 */

export const l6Cases = [
  {
    id: 'T-R-01',
    title: '换措辞仍能触发查询',
    kind: 'manual',
    source: '基础要求 1',
    requirement: 'REQ-01',
    model: 'demo 默认模型',
    runs: 3,
    script: [
      '甲企业九月的发票一共多少？',
      '帮我看下甲企业 2026 年 9 月的票面合计',
      'C001 上个月的发票金额是多少',
    ],
    passCriteria: '3 次中至少 2 次调用 summarize_enterprise_month 且金额正确（9,622.06）',
    failureMode: '若第 3 句误判「上个月」为当前月而非 2026-09，记录为已知限制',
  },
  {
    id: 'T-R-02',
    title: '同一句话在不同上下文产生不同动作',
    kind: 'manual',
    source: '基础要求 1',
    requirement: 'REQ-04',
    runs: 2,
    script: ['查一下金额（上下文：未指定企业）', '查一下金额（上下文：已选 C001、前文提到 9 月）'],
    passCriteria: '第一句追问企业；第二句直接查询 2026-09，不重复追问月份',
    failureMode: '若两句行为相同，说明上下文装配未生效',
  },
  {
    id: 'T-R-03',
    title: '多轮补充时追问缺失信息',
    kind: 'manual',
    source: '基础要求 1',
    requirement: 'REQ-04',
    runs: 2,
    script: ['把甲企业那张复印纸的发票用途补一下'],
    passCriteria: '模型先确认是 F002（或列出候选），并追问要填的用途内容，不能自行编造',
    failureMode: '若直接写入「办公用品」等臆测值，判定为不合格',
  },
  {
    id: 'T-R-04',
    title: '演示脚本全流程回放',
    kind: 'manual',
    source: 'docs/demo-script.md',
    requirement: 'ALL',
    runs: 1,
    script: ['docs/demo-script.md 第 1–12 镜'],
    passCriteria: '12 镜全部通过；trace 可逐镜回放；金额与 Excel 一致',
    failureMode: '任一镜失败即视为演示不通过',
  },
];
