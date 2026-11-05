/**
 * PostgreSQL schema（Drizzle）。
 *
 * **这是唯一的真源**：SQLite 版本是它的镜像，两者的字段名与语义必须一致，
 * 由契约测试保证。
 *
 * 规范化说明（详见 `docs/spec/14-industrial-refactor.md` §3）：
 * - 1NF：多值属性（企业别名、规则谓词、任务条目）各自成表
 * - 2NF：所有非键字段完整依赖复合主键
 * - 3NF：**不存 `issued_month`**，改用表达式索引，消除传递依赖
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/* ---------------------------- 主数据 ---------------------------- */

export const enterprise = pgTable('enterprise', {
  id: text('id').primaryKey(),
  legalName: text('legal_name').notNull(),
  status: text('status').notNull(), // active | inactive
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 别名是多值属性 → 独立表（1NF） */
export const enterpriseAlias = pgTable(
  'enterprise_alias',
  {
    enterpriseId: text('enterprise_id')
      .notNull()
      .references(() => enterprise.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
  },
  (t) => [primaryKey({ columns: [t.enterpriseId, t.alias] })],
);

export const appUser = pgTable('app_user', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  status: text('status').notNull(), // active | disabled
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accessGrant = pgTable(
  'access_grant',
  {
    userId: text('user_id')
      .notNull()
      .references(() => appUser.id),
    enterpriseId: text('enterprise_id')
      .notNull()
      .references(() => enterprise.id),
    accessLevel: text('access_level').notNull(), // read-write | read-only | none
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
    grantedBy: text('granted_by').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.enterpriseId] })],
);

/* ----------------------------- 台账 ----------------------------- */

export const invoice = pgTable(
  'invoice',
  {
    enterpriseId: text('enterprise_id')
      .notNull()
      .references(() => enterprise.id),
    invoiceNo: text('invoice_no').notNull(),
    issuedOn: date('issued_on').notNull(),
    sellerName: text('seller_name').notNull(),
    itemName: text('item_name').notNull(),
    amountCents: bigint('amount_cents', { mode: 'bigint' }).notNull(),
    purpose: text('purpose'),
    remark: text('remark'),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    updatedBy: text('updated_by').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.enterpriseId, t.invoiceNo] }),
    // 按月查询走表达式索引 —— 不存冗余月列，避免 3NF 违反
    index('idx_invoice_month').using(
      'btree',
      t.enterpriseId,
      sql`date_trunc('month', ${t.issuedOn})`,
    ),
    index('idx_invoice_missing_purpose').using(
      'btree',
      t.enterpriseId,
      sql`date_trunc('month', ${t.issuedOn})`,
    ),
  ],
);

export const bankTxn = pgTable(
  'bank_txn',
  {
    enterpriseId: text('enterprise_id')
      .notNull()
      .references(() => enterprise.id),
    txnNo: text('txn_no').notNull(),
    tradedOn: date('traded_on').notNull(),
    direction: text('direction').notNull(), // income | expense
    amountCents: bigint('amount_cents', { mode: 'bigint' }).notNull(),
    counterparty: text('counterparty').notNull(),
    remark: text('remark'),
  },
  (t) => [
    primaryKey({ columns: [t.enterpriseId, t.txnNo] }),
    index('idx_bank_month').using('btree', t.enterpriseId, sql`date_trunc('month', ${t.tradedOn})`),
  ],
);

/* ---------------------------- 规则库 ---------------------------- */

export const ruleDoc = pgTable(
  'rule_doc',
  {
    code: text('code').notNull(),
    version: text('version').notNull(),
    title: text('title').notNull(),
    category: text('category').notNull(),
    scopeKind: text('scope_kind').notNull(), // global | enterprise
    scopeEnt: text('scope_ent').references(() => enterprise.id),
    effectiveFrom: date('effective_from').notNull(),
    status: text('status').notNull(), // enabled | disabled
    body: text('body').notNull(),
    supersedes: text('supersedes'),
    supersededBy: text('superseded_by'),
    revision: integer('revision').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.code, t.version] }),
    index('idx_rule_scope').using('btree', t.scopeKind, t.status, t.effectiveFrom),
  ],
);

/** 谓词独立成表（1NF） */
export const ruleObligation = pgTable(
  'rule_obligation',
  {
    code: text('code').notNull(),
    version: text('version').notNull(),
    kind: text('kind').notNull(), // purpose_required_all | purpose_required_at_least
    thresholdCents: bigint('threshold_cents', { mode: 'bigint' }),
  },
  (t) => [
    primaryKey({ columns: [t.code, t.version] }),
    // 外键由迁移脚本添加（复合键引用）
  ],
);

/* ----------------------------- 记忆 ----------------------------- */

export const taskCard = pgTable(
  'task_card',
  {
    userId: text('user_id').notNull(),
    enterpriseId: text('enterprise_id').notNull(),
    month: date('month').notNull(),
    status: text('status').notNull(), // active | completed | abandoned
    note: text('note'),
    revision: integer('revision').notNull().default(1),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.enterpriseId] }),
    // 每用户每企业最多一个进行中
    uniqueIndex('uq_task_card_active')
      .on(t.userId, t.enterpriseId)
      .where(sql`${t.status} = 'active'`),
  ],
);

/** 任务条目独立成表（1NF） */
export const taskItem = pgTable(
  'task_item',
  {
    userId: text('user_id').notNull(),
    enterpriseId: text('enterprise_id').notNull(),
    invoiceNo: text('invoice_no').notNull(),
    state: text('state').notNull(), // pending | done | skipped
    note: text('note'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.enterpriseId, t.invoiceNo] })],
);

export const preference = pgTable(
  'preference',
  {
    userId: text('user_id').notNull(),
    enterpriseId: text('enterprise_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.enterpriseId, t.key] })],
);

/* ----------------------------- 会话 ----------------------------- */

export const conversation = pgTable('conversation', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  enterpriseId: text('enterprise_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull(),
});

export const conversationMessage = pgTable(
  'conversation_message',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role').notNull(), // user | assistant | tool
    content: text('content').notNull(),
    toolCallId: text('tool_call_id'),
    toolName: text('tool_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('uq_message_seq').on(t.conversationId, t.seq)],
);

/* ---------------------------- 写日志 ---------------------------- */

export const invoiceWriteLog = pgTable(
  'invoice_write_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    enterpriseId: text('enterprise_id').notNull(),
    invoiceNo: text('invoice_no').notNull(),
    field: text('field').notNull(), // purpose | remark
    oldValue: text('old_value'),
    newValue: text('new_value').notNull(),
    runId: text('run_id').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    actor: text('actor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('uq_write_log_run').on(t.enterpriseId, t.invoiceNo, t.field, t.newValue, t.runId),
    index('idx_write_log_time').on(sql`${t.createdAt} DESC`),
  ],
);
