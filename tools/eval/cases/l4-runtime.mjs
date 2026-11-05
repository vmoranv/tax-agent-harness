/**
 * L4 运行时契约用例。
 *
 * 这一层验的是「框架不骗人」：Stage 顺序真的按声明执行、
 * 工具 schema 真的无法被模型塞进计算字段、失败真的不会被改写成成功。
 */

export const l4Cases = [
  /* ------------------------------ Pipeline ------------------------------ */
  {
    id: 'L4-PIPE-01',
    title: 'Stage order 不连续时构造即失败',
    source: '08 §6',
    expect: '给定 order=1,2,4 → Pipeline 构造抛错，不静默重排',
  },
  {
    id: 'L4-PIPE-02',
    title: '洋葱模型：middleware 前后置顺序正确',
    source: '08 §6',
    expect: '执行序列为 Trace.pre → Session.pre → Session.post → Trace.post',
  },
  {
    id: 'L4-PIPE-03',
    title: 'terminal 短路后内层 Stage 完全未执行',
    source: '08 §6',
    expect: 'IdentityStage 返回 terminal → SessionStage 的 pre 调用次数为 0',
  },
  {
    id: 'L4-PIPE-04',
    title: 'stop 传播：后续 Stage 不执行但 finally 仍跑',
    source: '08 §6',
    expect: 'MemoryRecallStage 置 stopped → AgentStage 未执行；TraceStage 的 finally 已执行',
  },
  {
    id: 'L4-PIPE-05',
    title: '异常时 trace 仍落盘且保留原始错误',
    source: 'INV-21',
    expect: 'AgentStage 抛错 → trace 写入 error 步骤后原样抛出，不被吞',
  },

  /* ------------------------------ 工具 schema ------------------------------ */
  {
    id: 'L4-TOOL-01',
    title: '所有工具 inputSchema 可序列化为 JSON Schema',
    source: '08 §6',
    expect: 'zodToJsonSchema 对全部工具成功，无 ZodEffects 不可序列化错误',
  },
  {
    id: 'L4-TOOL-02',
    title: '工具 schema 不含计算结果字段',
    source: '08 §6',
    expect: '遍历所有 input schema，不存在 total/sum/allowed/compliant/net/balance 键',
  },
  {
    id: 'L4-TOOL-03',
    title: '所有工具 schema 不含 enterpriseId',
    source: '10 §4-1',
    expect: '任一工具 input 出现 enterpriseId → 测试失败（企业只从 RunContext 取）',
  },
  {
    id: 'L4-TOOL-04',
    title: 'summarize / gaps 工具的 month 必填',
    source: '10 §G1',
    expect: '不传 month 时 zod 校验失败，不落到默认当前月',
  },
  {
    id: 'L4-TOOL-05',
    title: '写工具不接受金额参数',
    source: '10 §4-7',
    expect: 'set_invoice_purpose / set_invoice_remark 的 schema 无 amount/total/price 键',
  },
  {
    id: 'L4-TOOL-06',
    title: '字段白名单只允许 purpose 与 remark',
    source: '10 §4-8',
    expect: "field 为 z.enum(['purpose','remark'])；传 'amount' 校验失败",
  },
  {
    id: 'L4-TOOL-07',
    title: '数字参数不使用 z.coerce',
    source: '10 §4-7',
    expect: "schema 中数值字段为 z.number().int()，传 '1000' 字符串被拒绝",
  },
  {
    id: 'L4-TOOL-08',
    title: 'repairToolCall 对写工具返回 null',
    source: '10 §4-9',
    expect: '写工具调用参数非法时不被自动修复，直接失败',
  },

  /* ------------------------------ 上下文装配 ------------------------------ */
  {
    id: 'L4-CTX-01',
    title: 'instructions 包含企业、月份、未完成事项三段',
    source: '基础要求 4',
    expect: 'system 文本同时含当前企业号、当前月份、TaskCard 待办清单',
  },
  {
    id: 'L4-CTX-02',
    title: '上下文超预算时按级降级且保留任务卡',
    source: '08 §6',
    expect: '裁剪后 TaskCard 段始终存在；历史消息按「摘要→截断→丢轮」顺序降级',
  },
  {
    id: 'L4-CTX-03',
    title: '中文 token 估算偏差小于 40%',
    source: '08 §6',
    expect: '估算值与真实 usage 的偏差绝对值 / 真实值 < 0.4',
  },
  {
    id: 'L4-CTX-04',
    title: '需要当前数据时必须重新查询而非复用旧结果',
    source: '基础要求 4',
    expect: '第二轮对话若未调用查询工具，上下文不注入上一轮的工具结果数字',
  },

  /* ------------------------------ 回复防护 ------------------------------ */
  {
    id: 'L4-GUARD-01',
    title: '金额溯源：草稿数字必须来自工具结果',
    source: 'INV-20',
    expect: '草稿含 9,622.06 且工具结果有该值 → provenance.ok=true',
  },
  {
    id: 'L4-GUARD-02',
    title: '金额溯源失败时改写或移除可疑数字',
    source: 'INV-20',
    expect: '草稿含 12345.67 但工具结果无 → 触发修复；二次校验仍失败则移除该数字',
  },
  {
    id: 'L4-GUARD-03',
    title: '失败不得被改写成「已保存」',
    source: '10 §4-3',
    expect: '工具返回 ok:false 时，最终文本不含「已保存」「已修改」「已更新」',
  },
  {
    id: 'L4-GUARD-04',
    title: '保存确认块由程序渲染而非模型生成',
    source: '10 §4-3',
    expect: '确认块含企业/发票/字段/旧值/新值/复核时间六项，且不来自模型文本',
  },
  {
    id: 'L4-GUARD-05',
    title: '无权限回复不得出现 0.00',
    source: 'INV-07',
    expect: "工具返回 denied → 最终文本不含任何金额数字，也不含 '0.00'",
  },
  {
    id: 'L4-GUARD-06',
    title: '规则引用缺失时拦截回复',
    source: 'INV-10',
    expect: '声明依据但未携带 code+version → MissingRuleCitation 被触发',
  },

  /* ------------------------------ 步数与兜底 ------------------------------ */
  {
    id: 'L4-LOOP-01',
    title: '超出 maxSteps 时强制结束且有最终文本',
    source: '08 §6',
    expect: '达到步数上限仍返回非空文本，trace 标记 truncated',
  },
  {
    id: 'L4-LOOP-02',
    title: '模型未给最终答复时兜底',
    source: '03 §Stage5',
    expect: '最后一轮仅含 tool-call → 兜底话术 + trace 标记 no-final-answer',
  },
  {
    id: 'L4-LOOP-03',
    title: '插件注册失败不影响核心流程',
    source: '04 §失败隔离',
    expect: '某插件 register 抛错 → 其余插件正常加载，trace 记录 plugin_load_failed',
  },
];
