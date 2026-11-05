/**
 * held-out 探针集完整性测试（vitest，随 `pnpm test` 跑）。
 * 保证：与训练集文本零重叠、覆盖新维度、gold 由 lib 独立算、spec.kind 都被 judge 支持。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fmtCentsGrouped, loadDataset, loadRules, ROOT, selectRules, summarize } from './lib.mjs';

const train = JSON.parse(readFileSync(join(ROOT, 'fixtures/eval/semantic-cases.json'), 'utf8'));
const held = JSON.parse(readFileSync(join(ROOT, 'fixtures/eval/heldout-cases.json'), 'utf8'));

const SUPPORTED_KINDS = ['amount', 'split', 'empty-month', 'rules', 'compound'];

describe('held-out 泛化探针集', () => {
  it('与 26 条训练集文本零重叠（防围标）', () => {
    const trainTexts = new Set(train.cases.map((c) => c.text));
    const dup = held.cases.filter((c) => trainTexts.has(c.text)).map((c) => c.id);
    expect(dup).toEqual([]);
    expect(held.no_overlap_with_train).toBe(true);
  });

  it('覆盖训练集没有的新维度', () => {
    expect(held.slices).toContain('empty-month');
    expect(held.slices).toContain('rule-explanation');
    expect(held.slices).toContain('compound');
    // 训练只用 08/09，held-out 含 07 空月
    expect(held.cases.some((c) => c.text.includes('7 月'))).toBe(true);
  });

  it('所有 spec.kind 都被 judge 支持', () => {
    const kinds = [...new Set(held.cases.map((c) => c.spec.kind))];
    for (const k of kinds) expect(SUPPORTED_KINDS).toContain(k);
  });

  it('金额 gold 与 lib.mjs 独立重算一致（不写死错值）', () => {
    const data = loadDataset();
    for (const c of held.cases.filter((x) => x.spec.goldInvoice)) {
      const m =
        c.text.includes('七月') || c.text.includes('7 月')
          ? '2026-07'
          : c.text.includes('八月') || c.text.includes('8 月') || c.text.includes('八 月')
            ? '2026-08'
            : '2026-09';
      const s = summarize(data, c.enterpriseId, m);
      expect(c.spec.goldInvoice).toBe(fmtCentsGrouped(s.invoiceTotalCents));
    }
  });

  it('规则 gold 与 selectRules 独立重算一致', () => {
    const rules = loadRules();
    for (const c of held.cases.filter((x) => x.spec.goldCodes)) {
      const m = c.text.includes('7 月')
        ? '2026-07'
        : c.text.includes('八月') || c.text.includes('8 月')
          ? '2026-08'
          : '2026-09';
      const sel = selectRules(rules, c.enterpriseId, m).selected.map((r) => r.code);
      expect(c.spec.goldCodes.slice().sort()).toEqual([...new Set(sel)].sort());
    }
  });
});
