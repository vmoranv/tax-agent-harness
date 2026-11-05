import { describe, expect, it } from 'vitest';
import {
  CausalSagaLedger,
  ClarificationEngine,
  DeadlockCircuitBreaker,
  DecisionMatrix,
  InputNormalizer,
} from '../src/index.js';

describe('Layer 1 · 输入规范化 (Input Normalization)', () => {
  const normalizer = new InputNormalizer();

  it('术语标准化：将口语化表达归一为财税标准术语', () => {
    const res = normalizer.normalize('查一下 9 月一共进了多少钱，出账了多少，还有没写用途的单子');
    expect(res.normalizedText).toContain('银行收入');
    expect(res.normalizedText).toContain('银行支出');
    expect(res.normalizedText).toContain('用途未填写');
    expect(
      res.normalizedTerms.进账 ||
        res.normalizedTerms.进了多少钱 ||
        Object.keys(res.normalizedTerms).length > 0,
    ).toBeTruthy();
  });

  it('指代消解：将“那张发票”、“刚才那笔”绑定回具体发票编号', () => {
    const res = normalizer.normalize('把刚才提到的那张发票用途改成咨询费', {
      lastMentionedInvoiceNo: 'F002',
    });
    expect(res.normalizedText).toContain('发票 F002');
    expect(
      res.resolvedEntities.那张发票 || Object.values(res.resolvedEntities).includes('F002'),
    ).toBeTruthy();
  });

  it('省略补全：根据上下文补齐缺失的月份与企业槽位建议', () => {
    const res = normalizer.normalize('查发票金额', {
      activeEnterprise: 'C001',
      activeMonth: '2026-09',
    });
    expect(res.completedSlots.month).toBe('2026-09');
  });

  it('连续同角色消息合并 (Smooshing)', () => {
    const messages = [
      { role: 'user', content: '查一下甲企业' },
      { role: 'user', content: '2026 年 9 月的数据' },
      { role: 'assistant', content: '收到' },
    ];
    const smooshed = normalizer.smooshMessages(messages);
    expect(smooshed).toHaveLength(2);
    expect(smooshed[0]?.content).toBe('查一下甲企业\n2026 年 9 月的数据');
  });
});

describe('Layer 2 · 感知决策 (Decision Matrix)', () => {
  const matrix = new DecisionMatrix();

  it('高理解 × 低风险 → 自主执行', () => {
    const evalResult = matrix.evaluate({
      text: '查询甲企业 C001 2026-09 的发票价税合计与银行收支',
      targetIntent: 'query',
      hasEnterprise: true,
      hasMonth: true,
    });
    expect(evalResult.understanding).toBe('high');
    expect(evalResult.risk).toBe('low');
    expect(evalResult.actionPolicy).toBe('autonomous_execute');
  });

  it('高理解 × 高风险 → 执行前确认与双向复核', () => {
    const evalResult = matrix.evaluate({
      text: '把甲企业 C001 的发票 F002 用途设为办公用品',
      targetIntent: 'modify',
      hasEnterprise: true,
      hasMonth: true,
      hasInvoiceTarget: true,
      hasNewContent: true,
    });
    expect(evalResult.understanding).toBe('high');
    expect(evalResult.risk).toBe('high');
    expect(evalResult.actionPolicy).toBe('confirm_before_execute');
  });

  it('低理解 × 低风险 → 声明假设并推进执行 (State Assumptions)', () => {
    const evalResult = matrix.evaluate({
      text: '查一下金额',
      targetIntent: 'query',
      hasEnterprise: true,
      hasMonth: false, // 缺少月份
    });
    expect(evalResult.understanding).toBe('low');
    expect(evalResult.risk).toBe('low');
    expect(evalResult.actionPolicy).toBe('assume_and_execute');
  });

  it('低理解 × 高风险 → 必须强制暂停并澄清 (Halt & Clarify)', () => {
    const evalResult = matrix.evaluate({
      text: '把用途改了',
      targetIntent: 'modify',
      hasEnterprise: false,
      hasMonth: false,
      hasInvoiceTarget: false,
      hasNewContent: false,
    });
    expect(evalResult.understanding).toBe('low');
    expect(evalResult.risk).toBe('high');
    expect(evalResult.actionPolicy).toBe('halt_and_clarify');
    expect(evalResult.missingSlots.length).toBeGreaterThan(0);
  });
});

describe('Layer 3 · 结构化引导 (Clarification Engine)', () => {
  const engine = new ClarificationEngine();

  it('Ask less 纪律：高风险缺口只提出一个高信号聚焦问题', () => {
    const matrix = new DecisionMatrix();
    const evaluation = matrix.evaluate({
      text: '把用途改成差旅费',
      targetIntent: 'modify',
      hasEnterprise: true,
      hasMonth: true,
      hasInvoiceTarget: false, // 缺少发票目标
      hasNewContent: true,
    });

    const clarification = engine.generateClarification(evaluation, {
      defaultEnterprise: '甲企业 C001',
      lastMentionedInvoiceNo: 'F002',
    });

    expect(clarification.shouldHalt).toBe(true);
    expect(clarification.question).toContain('发票编号');
    expect(clarification.recommendedAnswer).toBe('F002');
  });

  it('State assumptions：低风险缺口自动构造显式假设声明', () => {
    const matrix = new DecisionMatrix();
    const evaluation = matrix.evaluate({
      text: '查一下数据',
      targetIntent: 'query',
      hasEnterprise: true,
      hasMonth: false,
    });

    const clarification = engine.generateClarification(evaluation, {
      defaultMonth: '2026-09',
    });

    expect(clarification.shouldHalt).toBe(false);
    expect(clarification.statedAssumption).toContain('2026-09');
  });

  it('问题债务 (questionDebt) 跟踪与清偿机制', () => {
    const matrix = new DecisionMatrix();
    const evaluation = matrix.evaluate({
      text: '改一下用途',
      targetIntent: 'modify',
      hasEnterprise: true,
      hasMonth: false,
      hasInvoiceTarget: false,
      hasNewContent: false,
    });

    engine.generateClarification(evaluation);
    expect(engine.getPendingDebt()).toContain('invoiceNo');

    // 用户回答补充了发票号，清偿对应债务
    engine.resolveDebt('invoiceNo');
    expect(engine.getPendingDebt()).not.toContain('invoiceNo');
  });
});

describe('Layer 4 · 执行容错与因果感知 (Causal Saga & Deadlock Breaker)', () => {
  it('哈希链式 WAL 记录操作因果并计算防篡改哈希', () => {
    const saga = new CausalSagaLedger();
    const act1 = saga.recordAction({
      actionId: 'act_1',
      actionType: 'set_purpose',
      target: 'C001/F002',
      previousValue: null,
      appliedValue: '办公用品',
    });

    const act2 = saga.recordAction({
      actionId: 'act_2',
      actionType: 'set_purpose',
      target: 'C001/F002',
      previousValue: '办公用品',
      appliedValue: '日常采购',
    });

    expect(act2.prevHash).toBe(act1.hash);
    expect(saga.getHistory()).toHaveLength(2);
  });

  it('派生逆向补偿动作 (Compensations) 用于系统回滚', () => {
    const saga = new CausalSagaLedger();
    saga.recordAction({
      actionId: 'act_1',
      actionType: 'set_purpose',
      target: 'C001/F002',
      previousValue: '原用途A',
      appliedValue: '新用途B',
    });

    const compensations = saga.deriveCompensations();
    expect(compensations).toHaveLength(1);
    expect(compensations[0]?.target).toBe('C001/F002');
    expect(compensations[0]?.restoreValue).toBe('原用途A');
  });

  it('死锁熔断器：连续 3 次相同参数调用立即触发熔断', () => {
    const breaker = new DeadlockCircuitBreaker();
    expect(breaker.checkAndRecord('find_purpose_gaps', { month: '2026-09' }).tripped).toBe(false);
    expect(breaker.checkAndRecord('find_purpose_gaps', { month: '2026-09' }).tripped).toBe(false);

    const tripResult = breaker.checkAndRecord('find_purpose_gaps', { month: '2026-09' });
    expect(tripResult.tripped).toBe(true);
    expect(tripResult.reason).toContain('死锁保护熔断机制');
  });

  it('不同参数调用不会触发误熔断', () => {
    const breaker = new DeadlockCircuitBreaker();
    expect(breaker.checkAndRecord('find_purpose_gaps', { month: '2026-08' }).tripped).toBe(false);
    expect(breaker.checkAndRecord('find_purpose_gaps', { month: '2026-09' }).tripped).toBe(false);
    expect(breaker.checkAndRecord('find_purpose_gaps', { month: '2026-10' }).tripped).toBe(false);
  });
});
