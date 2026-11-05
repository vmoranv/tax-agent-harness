/**
 * 规则检索效果评测（确定性检索，非向量 IR）。
 *
 * 背景：评测中台的 `retrieval` 维度此前只是「用例 PASS 通过率」，
 * 并非 IR 指标（Precision/Recall/F1）。这里补一层真实检索效果评测：
 * - 被测系统 = 真实的 `Domain.selectApplicableRules`（domain 编译产物）；
 * - 候选知识库 = `fixtures/eval/rules.json`（5 条规则，经 rehydrate 构造）；
 * - Gold = **独立硬编码**的 `code@version` 集合，来自赛题/用例公认的正确适用规则，
 *   绝不由被测逻辑反推（否则等于自证）；
 * - 对 (C001|C002) × (2026-07|08|09) 六个查询各跑一次检索，
 *   把 `selected` 当作检索结果集合，计算 macro Precision / Recall / F1 与版本命中率。
 *
 * 这是「检索增强」里 Retrieval 环节的质量度量，与「向量库」无关：
 * 赛题允许简单文本检索/本地存储，本项目用确定性三重过滤，故用集合指标而非向量相似度。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadRules, ROOT } from './lib.mjs';

const DOMAIN_DIST = join(ROOT, 'packages/domain/dist/index.js');

/**
 * Gold 适用规则集（全类别 selected 的 code@version）。
 * 07/08 月：C001 的 R002 v2 未生效、v1 停用 → 只剩通用 R001/R004；
 * C002 的 R003@1.0 自 2026-08-01 起生效且启用，故 08/09 月适用（07 月未生效）。
 * C001/09 必须选 R002@2.0（不是停用的 1.0）；C002/09 必须选 R003@1.0。
 */
const GOLD_QUERIES = Object.freeze([
  { enterprise: 'C001', month: '2026-07', gold: ['R001@1.0', 'R004@1.0'] },
  { enterprise: 'C001', month: '2026-08', gold: ['R001@1.0', 'R004@1.0'] },
  { enterprise: 'C001', month: '2026-09', gold: ['R001@1.0', 'R002@2.0', 'R004@1.0'] },
  { enterprise: 'C002', month: '2026-07', gold: ['R001@1.0', 'R004@1.0'] },
  { enterprise: 'C002', month: '2026-08', gold: ['R001@1.0', 'R003@1.0', 'R004@1.0'] },
  { enterprise: 'C002', month: '2026-09', gold: ['R001@1.0', 'R003@1.0', 'R004@1.0'] },
]);

function toDocs(D, rules) {
  return rules.map((r) =>
    D.RuleDocument.rehydrate({
      code: D.ruleCode(r.code),
      version: D.ruleVersion(r.version),
      title: r.title,
      category: r.category,
      scope:
        r.scope === 'ALL'
          ? { kind: 'global' }
          : { kind: 'enterprise', enterpriseId: D.enterpriseId(r.scope) },
      effectiveFrom: D.parseIsoDate(r.effectiveFrom),
      status: r.status,
      obligation: r.obligation ?? null,
      body: r.body ?? `${r.title} ${r.version} 正文`,
      supersedes: null,
      supersededBy: null,
      updatedAt: D.parseIsoDate('2026-01-01'),
      revision: 0,
    }),
  );
}

function setOf(xs) {
  return new Set(xs);
}

function prf(gold, got) {
  const g = setOf(gold);
  const s = setOf(got);
  let tp = 0;
  for (const x of s) if (g.has(x)) tp += 1;
  const fp = s.size - tp;
  const fn = g.size - tp;
  const precision = s.size === 0 ? 0 : tp / s.size;
  const recall = g.size === 0 ? 1 : tp / g.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

/**
 * 计算检索指标。domain dist 缺失时返回 { available:false }。
 * 指标：逐查询 TP/FP/FN → macro P/R/F1 + 版本命中率；另附 micro 汇总。
 */
export async function computeRetrievalMetrics() {
  if (!existsSync(DOMAIN_DIST)) {
    return { available: false, reason: `缺少 ${DOMAIN_DIST}`, queries: [], macro: null };
  }
  const D = await import('../../packages/domain/dist/index.js');
  const rules = loadRules();
  const docs = toDocs(D, rules);

  const queries = [];
  for (const q of GOLD_QUERIES) {
    const sel = D.selectApplicableRules({
      candidates: docs,
      scope: D.enterpriseId(q.enterprise),
      asOfMonth: D.parseMonth(q.month),
      at: D.parseIsoDate(`${q.month}-10`),
    });
    const got = sel.selected.map((c) => `${c.code}@${c.version}`).sort();
    const gold = [...q.gold].sort();
    const metrics = prf(gold, got);
    const versionExact = JSON.stringify(got) === JSON.stringify(gold); // 集合与版本完全一致
    queries.push({
      enterprise: q.enterprise,
      month: q.month,
      gold,
      retrieved: got,
      ...metrics,
      versionExact,
    });
  }

  const n = queries.length;
  const macro = {
    precision: queries.reduce((a, q) => a + q.precision, 0) / n,
    recall: queries.reduce((a, q) => a + q.recall, 0) / n,
    f1: queries.reduce((a, q) => a + q.f1, 0) / n,
    versionHitRate: queries.filter((q) => q.versionExact).length / n,
    queryCount: n,
    candidateCount: rules.length,
  };
  // 微平均：汇总所有查询的 TP/FP/FN 后再算，避免小样本被 macro 平均稀释。
  const tp = queries.reduce((a, q) => a + q.tp, 0);
  const fp = queries.reduce((a, q) => a + q.fp, 0);
  const fn = queries.reduce((a, q) => a + q.fn, 0);
  const microPrecision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const microRecall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const microF1 =
    microPrecision + microRecall === 0
      ? 0
      : (2 * microPrecision * microRecall) / (microPrecision + microRecall);
  macro.micro = { precision: microPrecision, recall: microRecall, f1: microF1, tp, fp, fn };

  return { available: true, macro, queries, generatedAt: new Date().toISOString() };
}
