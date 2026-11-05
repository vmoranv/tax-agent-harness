-- 手工迁移：Drizzle 无法表达的数据库级约束
-- 应用顺序：在 0000 之后

-- 1) bank_txn 只读：类型层没有 save，数据库层再拦一道
CREATE OR REPLACE FUNCTION bank_txn_readonly() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'bank_txn is read-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bank_txn_no_update ON bank_txn;
CREATE TRIGGER bank_txn_no_update
  BEFORE UPDATE ON bank_txn
  FOR EACH ROW EXECUTE FUNCTION bank_txn_readonly();

DROP TRIGGER IF EXISTS bank_txn_no_delete ON bank_txn;
CREATE TRIGGER bank_txn_no_delete
  BEFORE DELETE ON bank_txn
  FOR EACH ROW EXECUTE FUNCTION bank_txn_readonly();

-- 2) rule_obligation → rule_doc 复合外键
ALTER TABLE rule_obligation
  DROP CONSTRAINT IF EXISTS fk_obligation_rule;
ALTER TABLE rule_obligation
  ADD CONSTRAINT fk_obligation_rule
  FOREIGN KEY (code, version) REFERENCES rule_doc(code, version) ON DELETE CASCADE;

-- 3) rule_obligation 结构约束：只有 at_least 才有阈值
ALTER TABLE rule_obligation
  DROP CONSTRAINT IF EXISTS ck_obligation_threshold;
ALTER TABLE rule_obligation
  ADD CONSTRAINT ck_obligation_threshold CHECK (
    (kind = 'purpose_required_all' AND threshold_cents IS NULL) OR
    (kind = 'purpose_required_at_least' AND threshold_cents > 0)
  );

-- 4) rule_doc scope 一致性
ALTER TABLE rule_doc
  DROP CONSTRAINT IF EXISTS ck_rule_scope_consistency;
ALTER TABLE rule_doc
  ADD CONSTRAINT ck_rule_scope_consistency CHECK (
    (scope_kind = 'global' AND scope_ent IS NULL) OR
    (scope_kind = 'enterprise' AND scope_ent IS NOT NULL)
  );

-- 5) task_item → task_card 复合外键
ALTER TABLE task_item
  DROP CONSTRAINT IF EXISTS fk_task_item_card;
ALTER TABLE task_item
  ADD CONSTRAINT fk_task_item_card
  FOREIGN KEY (user_id, enterprise_id) REFERENCES task_card(user_id, enterprise_id) ON DELETE CASCADE;
