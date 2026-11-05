/**
 * 内部工程评测维度（7 维）—— 依据《评测集如何构建》方法论自建，
 * **不是**赛题《01_参赛说明.docx》的评分维度，不可作为比赛得分依据。
 * 赛题官方评分维度与权重见 OFFICIAL_DIMENSIONS。
 *
 * 1. 结果 (End-to-End Result)
 * 2. RAG检索 (RAG Retrieval)
 * 3. 证据 (Evidence & Grounding)
 * 4. Agent过程 (Agent Process / Trajectory)
 * 5. 不确定性/异常 (Uncertainty & Anomaly)
 * 6. 工程质量 (Engineering Quality，静态代码分类，非运行时成本)
 * 7. 安全权限 (Security & Permissions)
 */

/** 赛题官方初赛评分维度（01_参赛说明.docx「初赛评分」），权重合计 100%。 */
export const OFFICIAL_DIMENSIONS = Object.freeze([
  {
    key: 'taskCompletion',
    name: '基础任务完成度',
    weight: 0.4,
    look: '主链路跑通、核心功能实现、保存结果可核对、记忆与知识管理可用',
  },
  {
    key: 'aiReasonableness',
    name: 'AI 技术应用合理性',
    weight: 0.25,
    look: '模型负责理解与决策，程序负责计算、校验与保存；能说明分工理由',
  },
  {
    key: 'problemUnderstanding',
    name: '问题理解',
    weight: 0.15,
    look: '分清记忆/规则/当前数据；追问明确；回复自然准确',
  },
  {
    key: 'futureSpace',
    name: '后续完善空间',
    weight: 0.1,
    look: '能指出当前不足，并说明怎样增加长对话、信息更新或任务恢复能力',
  },
  {
    key: 'innovation',
    name: '创新性',
    weight: 0.1,
    look: '有具体设计及示例，说明如何减少重复询问、用错规则或无关解释',
  },
]);

const DIMENSION_DEFINITIONS = {
  result: {
    name: '结果 (End-to-End Result)',
    desc: '端到端业务任务完成、短答案精准比对、最终数据库与实体状态匹配',
    target: 0.95,
  },
  // 注意：这是「用例 PASS 通过率」的内部工程维度，不是 IR 检索指标。
  // 真实 Precision/Recall/F1 见 run-eval.mjs 的 summary.retrieval（独立 IR 段落）。
  retrieval: {
    name: '规则过滤与版本决策（用例通过率）',
    desc: '相关评测用例（规则过滤/版本选择/排除停用与跨企业）的 PASS 占比；非 IR 检索指标，真实 P/R/F1 见「规则检索效果」段',
    target: 0.9,
  },
  grounding: {
    name: '证据 (Evidence & Grounding)',
    desc: '数字真实溯源 (Faithfulness)、规则依据精确引用、无依据禁止编造',
    target: 0.95,
  },
  trajectory: {
    name: 'Agent过程 (Agent Trajectory)',
    desc: '工具调用准确率 (Tool-Call F1)、执行步骤有效性、避免死循环与绕路',
    target: 0.9,
  },
  anomaly: {
    name: '不确定性与异常 (Uncertainty & Anomaly)',
    desc: '参数缺失主动追问 (拒答与澄清)、持久化异常优雅处理、网络与存储故障防御',
    target: 0.9,
  },
  efficiency: {
    name: '工程质量 (Engineering Quality)',
    desc: '静态工程分类：整数分无浮点、架构分层依赖边界(L7)、迁移与幂等、代码无冗余重复率控制。非运行时 token/延迟/成本度量（真实消耗见 trace_run，§8）',
    target: 0.9,
  },
  security: {
    name: '安全与权限 (Security & Permissions)',
    desc: '越权写入防御、自然语言提权拦截、Meta Rule of Two 约束、会话与多租户隔离',
    target: 1.0,
  },
};

/**
 * 依据用例 ID / Invariants / 场景自动归类至一个或多个 7 维指标中
 */
export function classifyDimensions(c) {
  const dims = new Set();
  const id = c.id || '';
  const invs = c.invariants || [];
  const req = c.requirement || '';

  // 1. 安全与权限
  if (
    id.includes('SEC') ||
    id.includes('ACL') ||
    invs.some((i) => ['INV-06', 'INV-07', 'INV-18', 'INV-19'].includes(i)) ||
    req.includes('REQ-06') ||
    req.includes('REQ-13') ||
    req.includes('REQ-18')
  ) {
    dims.add('security');
  }

  // 2. RAG 检索
  if (
    id.includes('RULE') ||
    id.includes('GAP') ||
    invs.some((i) => ['INV-08', 'INV-09', 'INV-10'].includes(i)) ||
    req.includes('REQ-03') ||
    req.includes('REQ-11') ||
    req.includes('REQ-15')
  ) {
    dims.add('retrieval');
  }

  // 3. 证据与溯源
  if (
    id.includes('GUARD') ||
    id.includes('TRACE') ||
    id.includes('STYLE') ||
    invs.some((i) => ['INV-10', 'INV-13', 'INV-20', 'INV-21'].includes(i)) ||
    req.includes('REQ-02') ||
    req.includes('REQ-16') ||
    req.includes('REQ-17')
  ) {
    dims.add('grounding');
  }

  // 4. Agent 过程与轨迹
  if (
    id.includes('PIPE') ||
    id.includes('TOOL') ||
    id.includes('TASK') ||
    id.includes('LOOP') ||
    c.script !== undefined ||
    invs.some((i) => ['INV-11', 'INV-16', 'INV-17', 'INV-22'].includes(i)) ||
    req.includes('REQ-08') ||
    req.includes('REQ-09') ||
    req.includes('REQ-10') ||
    req.includes('REQ-12')
  ) {
    dims.add('trajectory');
  }

  // 5. 不确定性与异常
  if (
    id.includes('T-S1-04') ||
    id.includes('T-S1-05') ||
    id.includes('T-S2-02') ||
    id.includes('T-GUESS') ||
    id.includes('L4-LOOP') ||
    c.title?.includes('追问') ||
    c.title?.includes('空月') ||
    c.title?.includes('失败') ||
    c.title?.includes('冲突') ||
    c.title?.includes('拒绝') ||
    c.title?.includes('不许') ||
    invs.some((i) => ['INV-14', 'INV-15'].includes(i)) ||
    req.includes('REQ-04') ||
    req.includes('REQ-05')
  ) {
    dims.add('anomaly');
  }

  // 6. 工程质量（静态代码分类，非运行时成本）
  if (
    id.includes('MONEY') ||
    id.includes('L7') ||
    id.includes('MIG') ||
    id.includes('IDEM') ||
    invs.some((i) => ['INV-12'].includes(i))
  ) {
    dims.add('efficiency');
  }

  // 7. 结果（端到端或业务核心计算）
  if (
    id.includes('SUM') ||
    id.includes('SET') ||
    id.includes('REMARK') ||
    id.includes('INV') ||
    id.startsWith('T-S')
  ) {
    dims.add('result');
  }

  // 默认兜底：如未分流归入 result
  if (dims.size === 0) {
    dims.add('result');
  }

  return [...dims];
}

/**
 * 计算 7 维度统计分值（内部工程指标，非赛题评分）。
 * - taggedCount 是「用例被标记到该维度的次数」之和，会因一例多标而大于实际用例数；
 *   uniqueCases 才是去重后的真实用例数，避免数字被放大。
 * - 没有可执行用例（pass+fail===0）时 score=null（N/A），不再伪装成 0%/DEGRADED。
 */
export function aggregateDimensions(results) {
  const summary = {};
  for (const [key, meta] of Object.entries(DIMENSION_DEFINITIONS)) {
    summary[key] = {
      ...meta,
      taggedCount: 0,
      uniqueCases: 0,
      pass: 0,
      fail: 0,
      pending: 0,
      blocked: 0,
      manual: 0,
      unverified: 0,
      score: null,
      health: 'N/A',
    };
  }

  const seen = {};
  for (const key of Object.keys(summary)) seen[key] = new Set();

  for (const r of results) {
    const dims = r.dimensions || classifyDimensions(r);
    for (const d of dims) {
      if (!summary[d]) continue;
      summary[d].taggedCount += 1;
      if (!seen[d].has(r.id)) {
        seen[d].add(r.id);
        summary[d].uniqueCases += 1;
      }
      if (r.status === 'PASS') summary[d].pass += 1;
      else if (r.status === 'FAIL') summary[d].fail += 1;
      else if (r.status === 'PENDING') summary[d].pending += 1;
      else if (r.status === 'BLOCKED') summary[d].blocked += 1;
      else if (r.status === 'MANUAL') summary[d].manual += 1;
      else if (r.status === 'UNVERIFIED') summary[d].unverified += 1;
    }
  }

  for (const item of Object.values(summary)) {
    const executable = item.pass + item.fail;
    item.score = executable === 0 ? null : item.pass / executable;
    item.health =
      item.fail > 0
        ? 'FAIL'
        : item.score === null
          ? 'N/A'
          : item.score >= item.target
            ? 'EXCELLENT'
            : 'DEGRADED';
  }

  return summary;
}
