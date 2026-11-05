/**
 * L3 适配器集成用例：SQLite、Excel 导入、幂等表、只读约束。
 *
 * 这些是最容易被"看起来对了"骗过的部分——类型层没有 save 方法
 * 不等于数据库层改不动。所以银行只读同时验类型与触发器。
 */

export const l3Cases = [
  /* ------------------------------ 迁移与表结构 ------------------------------ */
  {
    id: 'L3-MIG-01',
    title: '迁移连跑两次不报错（幂等）',
    source: '08 §5',
    invariants: ['INV-21'],
    expect: 'migrate() 连续执行两次，第二次不抛错，schema_version 不重复累加',
  },
  {
    id: 'L3-MIG-02',
    title: '复合主键允许同号不同企业并存',
    source: '08 §5',
    invariants: ['INV-01', 'INV-03'],
    expect: '插入 C001/F001 与 C002/F001 均成功；SELECT 分别返回 500.00 与 600.00',
  },
  {
    id: 'L3-MIG-03',
    title: '金额以整数分存取且往返无损',
    source: '08 §5',
    invariants: ['INV-12'],
    expect: "Money.parse('9622.06') 写入后读回 cents=962206n，格式化仍为 '9622.06'",
  },
  {
    id: 'L3-MIG-04',
    title: '空用途部分索引被查询计划使用',
    source: '08 §5',
    invariants: ['INV-15'],
    expect: 'EXPLAIN QUERY PLAN 中出现 idx_invoice_purpose_empty',
  },
  {
    id: 'L3-MIG-05',
    title: '发票主键冲突时走 upsert 而非静默覆盖',
    source: '05 §4',
    invariants: ['INV-01'],
    expect: '重复插入同主键且用途不同 → 抛约束或显式 upsert，绝不产生两行',
  },

  /* ------------------------------ 银行只读 ------------------------------ */
  {
    id: 'L3-BANK-01',
    title: '类型层：BankTransactionRepository 无 save/update/delete',
    source: '08 §5',
    invariants: ['INV-05'],
    expect: '接口上不存在 save/update/delete 方法（用 @ts-expect-error 锁定）',
  },
  {
    id: 'L3-BANK-02',
    title: '数据库层：UPDATE bank_txn 被触发器拒绝',
    source: '08 §5',
    invariants: ['INV-05'],
    expect: "直接执行 UPDATE bank_txn SET amount_cents=1 → 抛 'bank_txn is read-only'",
  },
  {
    id: 'L3-BANK-03',
    title: '数据库层：DELETE bank_txn 被触发器拒绝',
    source: '08 §5',
    invariants: ['INV-05'],
    expect: "直接执行 DELETE FROM bank_txn → 抛 'bank_txn is read-only'",
  },
  {
    id: 'L3-BANK-04',
    title: '数据库层：INSERT bank_txn 被触发器拒绝',
    source: '05 §3',
    invariants: ['INV-05'],
    expect: '直接执行 INSERT INTO bank_txn → 抛错（只读须覆盖三种写操作）',
  },

  /* ------------------------------ Excel 导入 ------------------------------ */
  {
    id: 'L3-IMP-01',
    title: '导入 40 票 48 流水且自检 matched',
    source: '08 §5',
    invariants: ['INV-12'],
    expect: 'invoices=40, bankTxns=48, enterprises=2, users=2；verification.matched===true',
  },
  {
    id: 'L3-IMP-02',
    title: '导入后 4 组月度合计与 Excel 说明页一致',
    source: '05 §5.3',
    invariants: ['INV-12'],
    expect: '8 月与 9 月两组企业的 6 个金额全部相等（含 9622.06 精确匹配）',
  },
  {
    id: 'L3-IMP-03',
    title: '缺列时抛 ImportSchemaError 并列出列名',
    source: '08 §5',
    invariants: ['INV-12'],
    expect: '删除「价税合计（元）」列 → ImportSchemaError，message 含该列名',
  },
  {
    id: 'L3-IMP-04',
    title: '日期不因时区偏移差一天',
    source: '08 §5',
    invariants: ['INV-12'],
    expect: "Excel 中 2026-09-01 导入后仍为 '2026-09-01'，不是 '2026-08-31'",
  },
  {
    id: 'L3-IMP-05',
    title: '三位小数金额被拒绝而非静默四舍五入',
    source: '05 §5.2',
    invariants: ['INV-12'],
    expect: '单元格 1000.005 → 该行进入 warnings 或被拒绝，不写成 1000.01',
  },
  {
    id: 'L3-IMP-06',
    title: '空白用途导入为 null 而非空串',
    source: '05 §5.2',
    invariants: ['INV-15'],
    expect: "C001/F002 的 purpose 在库中为 NULL；'   ' 也归一为 NULL",
  },
  {
    id: 'L3-IMP-07',
    title: '重复导入不覆盖用户已修改的用途',
    source: '参赛说明·数据管理',
    invariants: ['INV-04', 'INV-15'],
    expect:
      "先改 C001/F002 purpose='办公用品采购'，再执行一次导入 → 该值保持不变（不能被 Excel 里的空值覆盖）",
  },
  {
    id: 'L3-IMP-08',
    title: '重复导入不产生重复发票',
    source: '参赛说明·数据管理',
    invariants: ['INV-01'],
    expect: '连续导入两次后 invoice 表仍为 40 行、bank_txn 仍为 48 行',
  },
  {
    id: 'L3-IMP-09',
    title: '导入不修改银行流水',
    source: 'R004',
    invariants: ['INV-05'],
    expect: '重复导入后 bank_txn 的 updated 计数为 0（只读表不做 upsert）',
  },

  /* ------------------------------ 幂等与写入日志 ------------------------------ */
  {
    id: 'L3-IDEM-01',
    title: '同 requestId 二次 insert 主键冲突',
    source: '08 §5',
    invariants: ['INV-11'],
    expect: 'mutation_log 以 request_id 为主键，第二次插入抛约束错误（用例层已前置拦截）',
  },
  {
    id: 'L3-IDEM-02',
    title: '同 runId+toolCallId 唯一索引生效',
    source: '05 §7',
    invariants: ['INV-11'],
    expect: 'uq_write_log_run 拦截同一轮同一工具调用的第二次写入',
  },
  {
    id: 'L3-IDEM-03',
    title: '写入日志记录旧值新值与复核时刻',
    source: 'INV-16',
    invariants: ['INV-16'],
    expect: 'invoice_write_log 每行含 field / old_value / new_value / verified_at / actor',
  },
  {
    id: 'L3-IDEM-04',
    title: '乐观锁 version 冲突时更新影响 0 行',
    source: '08 §4',
    invariants: ['INV-11'],
    expect: 'UPDATE ... WHERE version=?: 传旧 version 时 changes=0，用例层据此返回 conflict',
  },

  /* ------------------------------ 规则库 ------------------------------ */
  {
    id: 'L3-RULE-01',
    title: '规则表主键为 (code, version)',
    source: '05 §3',
    invariants: ['INV-09'],
    expect: '可同时存在 R002@1.0 与 R002@2.0 两行；同 code 同 version 二次插入失败',
  },
  {
    id: 'L3-RULE-02',
    title: '停用状态持久化后仍被选择器排除',
    source: '基础要求 3',
    invariants: ['INV-08'],
    expect:
      '把 R002@2.0 状态改为 disabled 并重连数据库 → C001/09 的 gaps 变为 no-rule 或回落到 v1.0',
  },
  {
    id: 'L3-RULE-03',
    title: '规则版本更新生成新行而非原地改',
    source: '基础要求 3',
    invariants: ['INV-09'],
    expect: 'rule update R003 → 新增 R003@1.1 行，R003@1.0 保留并设置 superseded_by',
  },

  /* ------------------------------ 记忆与任务卡 ------------------------------ */
  {
    id: 'L3-MEM-01',
    title: '任务卡唯一索引：同 (user, enterprise) 两条 active 被拒',
    source: '08 §5',
    invariants: ['INV-17'],
    expect: 'uq_task_card_active 使第二次 insert 抛约束错误',
  },
  {
    id: 'L3-MEM-02',
    title: 'completed 状态的任务卡不占用唯一索引',
    source: '05 §4',
    invariants: ['INV-17'],
    expect: '旧卡置 completed 后，同 (user, enterprise) 可插入新 active 卡',
  },
  {
    id: 'L3-MEM-03',
    title: '偏好删除返回受影响行数',
    source: '08 §4',
    invariants: ['INV-18'],
    expect: 'DELETE 命中时 changes=1，未命中时 changes=0，用例层据此区分 deleted true/false',
  },
  {
    id: 'L3-MEM-04',
    title: '任务卡 payload JSON 往返无损',
    source: '05 §4',
    invariants: ['INV-18'],
    expect: 'pending/completed 集合写入再读出，顺序与内容完全一致',
  },

  /* ------------------------------ Trace ------------------------------ */
  {
    id: 'L3-TRACE-01',
    title: 'trace 以 JSONL 追加写，一行一个 JSON',
    source: '08 §5',
    invariants: ['INV-21'],
    expect: '每行可被 JSON.parse；追加不覆盖已有行',
  },
  {
    id: 'L3-TRACE-02',
    title: 'trace 记录本轮模型输入',
    source: '基础要求 6',
    invariants: ['INV-21'],
    expect: 'modelInput.instructions 非空；messages 条数与本轮实际一致',
  },
  {
    id: 'L3-TRACE-03',
    title: 'trace 记录选用的记忆与规则',
    source: '基础要求 6',
    invariants: ['INV-21'],
    expect: 'context.rules 含本轮 selected 的 code@version；context.memory 含任务卡快照',
  },
  {
    id: 'L3-TRACE-04',
    title: 'trace 不含 API Key',
    source: '基础要求 6',
    invariants: ['INV-21'],
    expect: '设置 HARNESS_LLM_API_KEY=<哨兵值> 后，trace 全文不含该哨兵值',
  },
  {
    id: 'L3-TRACE-05',
    title: 'trace 可被完整回放为同一决策序列',
    source: 'REQ-16 / 基础要求 6',
    requirement: 'REQ-16',
    invariants: ['INV-21'],
    expect: 'trace show <runId> --replay 输出的工具调用序列与原 run 完全一致（顺序、参数、结果）',
  },
  {
    id: 'L3-TRACE-06',
    title: 'trace 中的金额可被溯源校验使用',
    source: 'INV-20',
    invariants: ['INV-20'],
    expect: 'trace.toolResults 内的 9622.06 可被 extractNumbers 提取，供回复溯源比对',
  },
];
