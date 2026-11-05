import { describe, expect, it } from 'vitest';
import type { RuleCategory, RuleSelection } from '../src/index.js';
import {
  ALL_SCOPE,
  atLeast,
  compareVersions,
  emptySelection,
  enterpriseId,
  formatCitation,
  parseIsoDate,
  parseMonth,
  RuleDocument,
  RuleSelectionAmbiguousError,
  rejectionCounts,
  ruleCode,
  ruleVersion,
  selectApplicableRules,
  selectedIds,
  selectionFingerprint,
} from '../src/index.js';

const C001 = enterpriseId('C001');
const C002 = enterpriseId('C002');

const D_2026_01_01 = parseIsoDate('2026-01-01');
const _D_2026_08_01 = parseIsoDate('2026-08-01');
const D_2026_08_15 = parseIsoDate('2026-08-15');
const D_2026_08_20 = parseIsoDate('2026-08-20');
const _D_2026_09_01 = parseIsoDate('2026-09-01');
const D_2026_09_30 = parseIsoDate('2026-09-30');

const SEP = parseMonth('2026-09');
const AUG = parseMonth('2026-08');

interface RuleSpec {
  readonly code: string;
  readonly version: string;
  readonly scope: 'global' | 'C001' | 'C002';
  readonly effectiveFrom: string;
  readonly category?: RuleCategory;
  readonly obligation?: 'all' | 'atLeast1000' | null;
}

/**
 * 与 fixtures/golden.ts 的 GOLDEN_RULES 对齐的一组候选：
 * - R001 全局金额指引，2026-01-01 起生效
 * - R002 仅 C001 的用途规则：v1.0（2026-08-01，停用）→ v2.0（2026-09-01，全部必填）
 * - R003 仅 C002 的用途规则：v1.0（2026-08-01，门槛 1000）
 * - R004 全局银行指引
 */
function rule(spec: RuleSpec): RuleDocument {
  const category = spec.category ?? 'purpose-requirement';
  const obligationSpec = spec.obligation === undefined ? 'all' : spec.obligation;
  const obligation =
    obligationSpec === 'all'
      ? ({ kind: 'purpose_required_all' } as const)
      : obligationSpec === 'atLeast1000'
        ? atLeast('1000.00')
        : null;

  return RuleDocument.draft({
    code: ruleCode(spec.code),
    version: ruleVersion(spec.version),
    title: `规则 ${spec.code}（模拟）`,
    category,
    scope:
      spec.scope === 'global'
        ? { kind: 'global' }
        : { kind: 'enterprise', enterpriseId: spec.scope === 'C001' ? C001 : C002 },
    effectiveFrom: parseIsoDate(spec.effectiveFrom),
    obligation,
    body: '模拟规则正文',
    supersedes: null,
    updatedAt: D_2026_01_01,
  });
}

/** 标准四件套（R002 v1.0 已停用）。 */
function candidates(): RuleDocument[] {
  const r002v1 = rule({
    code: 'R002',
    version: '1.0',
    scope: 'C001',
    effectiveFrom: '2026-08-01',
  });
  r002v1.disable(D_2026_08_15, '被 v2.0 取代，过渡期结束');

  return [
    rule({
      code: 'R001',
      version: '1.0',
      scope: 'global',
      effectiveFrom: '2026-01-01',
      category: 'amount-guidance',
      obligation: null,
    }),
    r002v1,
    rule({ code: 'R002', version: '2.0', scope: 'C001', effectiveFrom: '2026-09-01' }),
    rule({
      code: 'R003',
      version: '1.0',
      scope: 'C002',
      effectiveFrom: '2026-08-01',
      obligation: 'atLeast1000',
    }),
    rule({
      code: 'R004',
      version: '1.0',
      scope: 'global',
      effectiveFrom: '2026-01-01',
      category: 'bank-guidance',
      obligation: null,
    }),
  ];
}

function idsOf(sel: RuleSelection): string[] {
  return sel.selected.map((c) => `${c.code}@${c.version}`);
}

function reasonsFor(sel: RuleSelection, code: string, version: string): string[] {
  return sel.rejected.filter((r) => r.code === code && r.version === version).map((r) => r.reason);
}

describe('selectApplicableRules —— C001 / 2026-09', () => {
  it('选中 R001@1.0、R002@2.0、R004@1.0（与 GOLDEN_RULES 一致）', () => {
    const sel = selectApplicableRules({ candidates: candidates(), scope: C001, asOfMonth: SEP });
    expect(idsOf(sel)).toEqual(['R001@1.0', 'R002@2.0', 'R004@1.0']);
    expect(selectedIds(sel)).toEqual(['R001@1.0', 'R002@2.0', 'R004@1.0']);
    expect(sel.algorithmVersion).toBe('triple-filter-v1');
  });

  it('R002@1.0 因 disabled 被排除，且原因被记录', () => {
    const sel = selectApplicableRules({ candidates: candidates(), scope: C001, asOfMonth: SEP });
    expect(reasonsFor(sel, 'R002', '1.0')).toEqual(['disabled']);
    expect(sel.rejected.find((r) => r.code === 'R002' && r.version === '1.0')?.detail).toContain(
      '停用',
    );
  });

  it('R003 是 C002 专属，对 C001 记为 other-enterprise', () => {
    const sel = selectApplicableRules({ candidates: candidates(), scope: C001, asOfMonth: SEP });
    expect(reasonsFor(sel, 'R003', '1.0')).toEqual(['other-enterprise']);
    expect(idsOf(sel)).not.toContain('R003@1.0');
  });

  it('被排除的每一条都能解释，不留静默丢弃', () => {
    const sel = selectApplicableRules({ candidates: candidates(), scope: C001, asOfMonth: SEP });
    // 5 条候选 = 3 选中 + 2 淘汰
    expect(sel.selected.length + sel.rejected.length).toBe(5);
    for (const r of sel.rejected) expect(r.detail.length).toBeGreaterThan(0);
  });

  it('选中项按 code 升序、引用信息可直接进回复', () => {
    const sel = selectApplicableRules({ candidates: candidates(), scope: C001, asOfMonth: SEP });
    const codes = sel.selected.map((c) => c.code);
    expect([...codes].sort()).toEqual(codes);
    const r002 = sel.selected.find((c) => c.code === 'R002');
    expect(r002).toBeDefined();
    if (r002) {
      expect(r002.version).toBe('2.0');
      expect(r002.scopeLabel).toBe('C001');
      expect(formatCitation(r002)).toBe('R002 规则 R002（模拟） v2.0');
    }
    const r001 = sel.selected.find((c) => c.code === 'R001');
    expect(r001?.scopeLabel).toBe('全局');
  });
});

describe('selectApplicableRules —— C002 / 2026-09', () => {
  it('选中 R001、R003、R004；R002 两条都不适用', () => {
    const sel = selectApplicableRules({ candidates: candidates(), scope: C002, asOfMonth: SEP });
    expect(idsOf(sel)).toEqual(['R001@1.0', 'R003@1.0', 'R004@1.0']);
    expect(reasonsFor(sel, 'R002', '2.0')).toEqual(['other-enterprise']);
    // v1.0 先撞停用，故原因不是 other-enterprise —— 判定顺序固定
    expect(reasonsFor(sel, 'R002', '1.0')).toEqual(['disabled']);
  });
});

describe('selectApplicableRules —— C001 / 2026-08（月界语义）', () => {
  it('9 月 1 日才生效的 R002@2.0 不属于 8 月：结果里根本不含 R002', () => {
    const sel = selectApplicableRules({ candidates: candidates(), scope: C001, asOfMonth: AUG });
    expect(idsOf(sel)).toEqual(['R001@1.0', 'R004@1.0']);
    expect(sel.selected.some((c) => c.code === 'R002')).toBe(false);
    expect(sel.rejected.some((r) => r.code === 'R002' && r.version === '2.0')).toBe(true);
    expect(reasonsFor(sel, 'R002', '2.0')).toEqual(['not-yet-effective']);
  });

  it('8 月的 R002@1.0 仍是 disabled，而不是「生效了」', () => {
    const sel = selectApplicableRules({ candidates: candidates(), scope: C001, asOfMonth: AUG });
    expect(reasonsFor(sel, 'R002', '1.0')).toEqual(['disabled']);
  });
});

describe('selectApplicableRules —— 停用/启用的因果', () => {
  it('把 R002@1.0 重新启用后，它会在 8 月被选中，在 9 月被 superseded', () => {
    const docs = candidates();
    const v1 = docs.find((d) => d.id === 'R002@1.0');
    expect(v1).toBeDefined();
    v1?.enable(D_2026_08_20);

    const aug = selectApplicableRules({ candidates: docs, scope: C001, asOfMonth: AUG });
    expect(idsOf(aug)).toEqual(['R001@1.0', 'R002@1.0', 'R004@1.0']);

    const sep = selectApplicableRules({ candidates: docs, scope: C001, asOfMonth: SEP });
    expect(idsOf(sep)).toEqual(['R001@1.0', 'R002@2.0', 'R004@1.0']);
    expect(reasonsFor(sep, 'R002', '1.0')).toEqual(['superseded']);
  });
});

describe('selectApplicableRules —— superseded 与歧义', () => {
  it('同 code 两个有效版本，取 effectiveFrom 较新的一个，旧的记 superseded', () => {
    const docs = [
      rule({ code: 'R002', version: '1.0', scope: 'C001', effectiveFrom: '2026-08-01' }),
      rule({ code: 'R002', version: '2.0', scope: 'C001', effectiveFrom: '2026-09-01' }),
    ];
    const sel = selectApplicableRules({ candidates: docs, scope: C001, asOfMonth: SEP });
    expect(idsOf(sel)).toEqual(['R002@2.0']);
    expect(reasonsFor(sel, 'R002', '1.0')).toEqual(['superseded']);
  });

  it('同一天生效的两个版本 → RuleSelectionAmbiguousError，绝不「取第一条」', () => {
    const docs = [
      rule({ code: 'R002', version: '1.0', scope: 'C001', effectiveFrom: '2026-09-01' }),
      rule({ code: 'R002', version: '2.0', scope: 'C001', effectiveFrom: '2026-09-01' }),
    ];
    expect(() => selectApplicableRules({ candidates: docs, scope: C001, asOfMonth: SEP })).toThrow(
      RuleSelectionAmbiguousError,
    );
  });
});

describe('selectApplicableRules —— 类别过滤与汇总', () => {
  it('neededCategories 只留用途类，其余记 category-not-needed', () => {
    const sel = selectApplicableRules({
      candidates: candidates(),
      scope: C001,
      asOfMonth: SEP,
      neededCategories: ['purpose-requirement'],
    });
    expect(idsOf(sel)).toEqual(['R002@2.0']);
    expect(reasonsFor(sel, 'R001', '1.0')).toEqual(['category-not-needed']);
    expect(reasonsFor(sel, 'R004', '1.0')).toEqual(['category-not-needed']);
    expect(rejectionCounts(sel)['category-not-needed']).toBe(2);
  });

  it('rejectionCounts 按原因计数，且五个原因键始终存在', () => {
    const sel = selectApplicableRules({ candidates: candidates(), scope: C001, asOfMonth: SEP });
    const counts = rejectionCounts(sel);
    expect(Object.keys(counts).sort()).toEqual([
      'category-not-needed',
      'disabled',
      'not-yet-effective',
      'other-enterprise',
      'superseded',
    ]);
    expect(counts.disabled).toBe(1);
    expect(counts['other-enterprise']).toBe(1);
    expect(counts['not-yet-effective']).toBe(0);
  });

  it("scope='ALL' 时不做企业过滤，两家企业专属规则同池竞争", () => {
    const sel = selectApplicableRules({
      candidates: candidates(),
      scope: ALL_SCOPE,
      asOfMonth: SEP,
    });
    // C001 的 R002@2.0 与 C002 的 R003@1.0 都在池中
    expect(sel.selected.some((c) => c.code === 'R002')).toBe(true);
    expect(sel.selected.some((c) => c.code === 'R003')).toBe(true);
  });

  it('resolvedAt 默认取月初，显式传入时以传入为准', () => {
    const dflt = selectApplicableRules({ candidates: candidates(), scope: C001, asOfMonth: SEP });
    expect(dflt.resolvedAt).toBe('2026-09-01');
    const explicit = selectApplicableRules({
      candidates: candidates(),
      scope: C001,
      asOfMonth: SEP,
      at: D_2026_09_30,
    });
    expect(explicit.resolvedAt).toBe('2026-09-30');
  });
});

describe('selectionFingerprint', () => {
  it('同一输入指纹稳定（供 trace 去重）', () => {
    const a = selectApplicableRules({ candidates: candidates(), scope: C001, asOfMonth: SEP });
    const b = selectApplicableRules({ candidates: candidates(), scope: C001, asOfMonth: SEP });
    expect(selectionFingerprint(a)).toBe(selectionFingerprint(b));
    expect(selectionFingerprint(a)).toMatch(/^rs1-[0-9a-f]{8}$/);
  });

  it('选中版本变化或月份变化，指纹必然变化（供回放校验）', () => {
    const sep = selectApplicableRules({ candidates: candidates(), scope: C001, asOfMonth: SEP });
    const aug = selectApplicableRules({ candidates: candidates(), scope: C001, asOfMonth: AUG });
    expect(selectionFingerprint(sep)).not.toBe(selectionFingerprint(aug));

    const other = selectApplicableRules({ candidates: candidates(), scope: C002, asOfMonth: SEP });
    expect(selectionFingerprint(sep)).not.toBe(selectionFingerprint(other));
  });

  it('淘汰原因变化也会改变指纹', () => {
    const base = selectApplicableRules({ candidates: candidates(), scope: C001, asOfMonth: SEP });
    const docs = candidates();
    docs.find((d) => d.id === 'R002@1.0')?.enable(D_2026_08_20);
    const enabled = selectApplicableRules({ candidates: docs, scope: C001, asOfMonth: SEP });
    expect(selectionFingerprint(base)).not.toBe(selectionFingerprint(enabled));
  });
});

describe('emptySelection 与 compareVersions', () => {
  it('空选择仍带企业与月份，便于审计「查了但没有」', () => {
    const s = emptySelection(C001, SEP, D_2026_09_30);
    expect(s.selected).toEqual([]);
    expect(s.rejected).toEqual([]);
    expect(s.enterpriseId).toBe('C001');
    expect(s.asOfMonth).toBe('2026-09');
  });

  it('版本比较按数值分段，而非字符串', () => {
    expect(compareVersions('2.0', '1.10')).toBe(1);
    expect(compareVersions('1.10', '1.9')).toBe(1);
    expect(compareVersions('2.0', '2.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.1')).toBe(-1);
  });
});
