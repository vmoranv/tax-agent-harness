/**
 * 完整 DDL。
 *
 * 三条关键约束（不是约定，是数据库强制）：
 * 1. `invoice` 有 `version` 列 —— 乐观锁
 * 2. `bank_txn` 有 BEFORE UPDATE/DELETE 触发器 —— 银行流水只读
 * 3. `task_card` 有部分唯一索引 `WHERE state='active'` —— 每用户每企业最多一个进行中任务
 */

export const SCHEMA_VERSION = 1;

export const CREATE_SCHEMA = `
-- ============================ 主数据 ============================
CREATE TABLE IF NOT EXISTS enterprise (
  id          TEXT PRIMARY KEY,
  legal_name  TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]',   -- JSON 数组
  status      TEXT NOT NULL CHECK (status IN ('active','inactive')),
  version     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_user (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active','disabled')),
  version       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grant (
  user_id       TEXT NOT NULL,
  enterprise_id TEXT NOT NULL,
  access_level  TEXT NOT NULL CHECK (access_level IN ('read-write','read-only','none')),
  granted_at    TEXT NOT NULL,
  granted_by    TEXT NOT NULL,
  PRIMARY KEY (user_id, enterprise_id)
);

-- ============================== 台账 ==============================
CREATE TABLE IF NOT EXISTS invoice (
  enterprise_id TEXT NOT NULL,
  invoice_no    TEXT NOT NULL,
  issued_on     TEXT NOT NULL,
  issued_month  TEXT NOT NULL,
  seller_name   TEXT NOT NULL,
  item_name     TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  purpose       TEXT,
  remark        TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL,
  updated_by    TEXT NOT NULL,
  PRIMARY KEY (enterprise_id, invoice_no)
);
CREATE INDEX IF NOT EXISTS idx_invoice_month ON invoice (enterprise_id, issued_month);

CREATE TABLE IF NOT EXISTS bank_txn (
  enterprise_id TEXT NOT NULL,
  txn_no        TEXT NOT NULL,
  traded_on     TEXT NOT NULL,
  traded_month  TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('income','expense')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  counterparty  TEXT NOT NULL,
  remark        TEXT,
  PRIMARY KEY (enterprise_id, txn_no)
);
CREATE INDEX IF NOT EXISTS idx_bank_month ON bank_txn (enterprise_id, traded_month);

-- 银行只读：类型层没有 save，数据库层再拦一道
CREATE TRIGGER IF NOT EXISTS bank_txn_readonly_update
BEFORE UPDATE ON bank_txn
BEGIN
  SELECT RAISE(ABORT, 'bank_txn is read-only');
END;

CREATE TRIGGER IF NOT EXISTS bank_txn_readonly_delete
BEFORE DELETE ON bank_txn
BEGIN
  SELECT RAISE(ABORT, 'bank_txn is read-only');
END;

-- ============================= 规则库 =============================
CREATE TABLE IF NOT EXISTS rule_doc (
  code           TEXT NOT NULL,
  version        TEXT NOT NULL,
  title          TEXT NOT NULL,
  category       TEXT NOT NULL,
  scope_kind     TEXT NOT NULL CHECK (scope_kind IN ('global','enterprise')),
  scope_ent      TEXT,
  effective_from TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('enabled','disabled')),
  obligation     TEXT NOT NULL,             -- JSON
  body           TEXT NOT NULL,
  supersedes     TEXT,
  superseded_by  TEXT,
  revision       INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (code, version)
);

-- ============================== 记忆 ==============================
CREATE TABLE IF NOT EXISTS task_card (
  user_id       TEXT NOT NULL,
  enterprise_id TEXT NOT NULL,
  month         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active','completed','abandoned')),
  payload       TEXT NOT NULL,              -- JSON
  revision      INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, enterprise_id)
);
-- 每用户每企业最多一个进行中任务
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_card_active
  ON task_card (user_id, enterprise_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS preference (
  user_id       TEXT NOT NULL,
  enterprise_id TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, enterprise_id, key)
);

-- ============================== 会话 ==============================
CREATE TABLE IF NOT EXISTS session (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  enterprise_id  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_owner
  ON session (user_id, enterprise_id, last_active_at DESC);

CREATE TABLE IF NOT EXISTS message (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_session ON message (session_id, id);

-- ============================ 运行记录 ============================
CREATE TABLE IF NOT EXISTS trace_run (
  run_id        TEXT PRIMARY KEY,
  session_id    TEXT,
  user_id       TEXT,
  enterprise_id TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  elapsed_ms    INTEGER NOT NULL DEFAULT 0,
  payload       TEXT NOT NULL,
  final_preview TEXT NOT NULL DEFAULT '',
  has_error     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trace_time ON trace_run (started_at DESC);

-- ============================ 幂等与日志 ============================
CREATE TABLE IF NOT EXISTS mutation_log (
  request_id   TEXT PRIMARY KEY,
  operation    TEXT NOT NULL,
  target_ref   TEXT NOT NULL,
  result       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_write_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  enterprise_id TEXT NOT NULL,
  invoice_no    TEXT NOT NULL,
  field         TEXT NOT NULL CHECK (field IN ('purpose','remark')),
  old_value     TEXT,
  new_value     TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  tool_call_id  TEXT NOT NULL,
  actor         TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
-- 同一轮对同一目标的同一新值只可能落一条
CREATE UNIQUE INDEX IF NOT EXISTS uq_write_log_run
  ON invoice_write_log (enterprise_id, invoice_no, field, new_value, run_id);

-- ============================ 插件存储 ============================
CREATE TABLE IF NOT EXISTS plugin_storage (
  plugin_id  TEXT NOT NULL,
  ns         TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, ns, key)
);

CREATE TABLE IF NOT EXISTS schema_migration (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;
