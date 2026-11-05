/**
 * 向量检索「诊断对照值」（本地确定性哈希嵌入玩具实验，**不是**可信评分）。
 *
 * ⚠️ 定位（2026-11-05 复核后降级）：本模块产出的 P/R/F1 **不是**一个可信的
 * 「向量化分数」，不得用于衡量检索质量、不得横向比较、不得对外宣传为评分。
 * 它只是一个可复算的**结构诊断对照**：演示「若把规则检索换成字符哈希向量检索
 * 会发生什么」，用于暴露为什么本项目坚持确定性三重过滤。
 *
 * 诚实边界 / 方法学缺陷（已验证，三条）：
 * - 项目规则检索是**确定性三重过滤**（停用状态、企业 scope、生效月份按 code 取最新），
 *   **没有向量库、没有 embedding 模型、没有调用任何 embedding 服务**；本模块绝非真实语义 embedding。
 * - **label leak**：查询文本由 gold 规则的 title 拼成，等于把答案喂给查询，方法学不自洽。
 * - **版本不可分**：R002@1.0 与 R002@2.0 的 title 完全相同 → 两条候选嵌入向量逐位相同
 *   （实测余弦恒等），而 gold 要求区分停用 v1 / 生效 v2，结构上不可能答对。
 * - **不稳健**：查询串增删几个无关字符（如「年」「2026」），macro F1 在 0.58 / 0.94 / 1.00
 *   间大幅跳变；分数取决于文本拼法而非检索质量。
 * - 实测 macro P/R/F1 ≈ 0.583 只是上述缺陷下的一个具体取值，**无质量含义**。
 *
 * 算法（纯函数、零外部状态、可离线）：
 *   全体文本 → 字符 unigram + 相邻 2-gram 词表 → 词频向量 → L2 归一化 → 余弦 = 点积；
 *   每个查询取 topK = gold.length 的相似候选作为 retrieved，按集合口径算 P/R/F1。
 *   gold 集与 tools/eval/retrieval-metrics.mjs 的 GOLD_QUERIES 一致（6 个企业×月查询）。
 */
import { ENTERPRISE_LABEL, loadRules } from './lib.mjs';

/** Gold 适用规则集，与 retrieval-metrics.mjs 的 GOLD_QUERIES 逐条对齐（独立硬编码）。 */
const GOLD_QUERIES = Object.freeze([
  { enterprise: 'C001', month: '2026-07', gold: ['R001@1.0', 'R004@1.0'] },
  { enterprise: 'C001', month: '2026-08', gold: ['R001@1.0', 'R004@1.0'] },
  { enterprise: 'C001', month: '2026-09', gold: ['R001@1.0', 'R002@2.0', 'R004@1.0'] },
  { enterprise: 'C002', month: '2026-07', gold: ['R001@1.0', 'R004@1.0'] },
  { enterprise: 'C002', month: '2026-08', gold: ['R001@1.0', 'R003@1.0', 'R004@1.0'] },
  { enterprise: 'C002', month: '2026-09', gold: ['R001@1.0', 'R003@1.0', 'R004@1.0'] },
]);

const FALLBACK_LABEL = { C001: '甲企业', C002: '乙企业' };

/**
 * 字符/词元切分：去空白后，逐字符 unigram + 相邻字符 2-gram。
 * unigram 长度为 1、bigram 长度为 2，二者字符串不会碰撞。
 */
function tokenize(text) {
  const chars = Array.from(String(text).replace(/\s+/g, ''));
  const tokens = [];
  for (const ch of chars) tokens.push(ch);
  for (let i = 0; i < chars.length - 1; i += 1) {
    tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}

/** 全体语料（候选 + 查询）的词表：token → 稠密下标。 */
function buildVocab(texts) {
  const vocab = new Map();
  for (const text of texts) {
    for (const token of tokenize(text)) {
      if (!vocab.has(token)) vocab.set(token, vocab.size);
    }
  }
  return vocab;
}

/** 词频向量 + L2 归一化；空文本或零向量保持为零向量（不会产生 NaN）。 */
function vectorize(text, vocab) {
  const vec = new Float64Array(vocab.size);
  for (const token of tokenize(text)) {
    const idx = vocab.get(token);
    if (idx !== undefined) vec[idx] += 1;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  const len = Math.sqrt(norm);
  if (len > 0) {
    for (let i = 0; i < vec.length; i += 1) vec[i] /= len;
  }
  return vec;
}

/** 两个已 L2 归一化的向量，余弦 = 点积；非负计数向量钳到 [0, 1] 去掉浮点误差。 */
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return Math.min(1, Math.max(0, dot));
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/** 集合口径 P/R/F1，与 retrieval-metrics.mjs 的 prf 完全一致。 */
function prf(gold, got) {
  const g = new Set(gold);
  const s = new Set(got);
  let tp = 0;
  for (const x of s) if (g.has(x)) tp += 1;
  const precision = s.size === 0 ? 0 : tp / s.size;
  const recall = g.size === 0 ? 1 : tp / g.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/** 从规则 title 抽自然语言关键词：去企业前缀、去「说明/规则/要求」等泛化后缀。 */
function titleKeyword(title) {
  return String(title)
    .replace(/^(甲企业|乙企业)/, '')
    .replace(/(说明|规则|要求|指引|规范)$/g, '');
}

/** 候选嵌入文本：title + category + scope（ALL 记作「通用」）。 */
function candidateText(rule) {
  const scope = rule.scope === 'ALL' ? '通用' : rule.scope;
  return `${rule.title} ${rule.category} ${scope}`;
}

/** 自然语言查询文本：企业中文名 + 年月 + gold 规则 title 关键词。 */
function queryText(q, ruleById, label) {
  const [year, mm] = q.month.split('-');
  const monthLabel = `${year} 年 ${Number(mm)} 月`;
  const keywords = [...new Set(q.gold.map((id) => titleKeyword(ruleById.get(id).title)))];
  return `${label} ${monthLabel} ${keywords.join(' ')}`;
}

/**
 * 计算向量检索基线 IR 指标。纯本地、无网络、无 DB、无随机数，可重复 import 结果稳定。
 * @returns {Promise<object>} 见文件头字段契约。
 */
export async function computeVectorMetrics() {
  const rules = loadRules();
  const label = ENTERPRISE_LABEL ?? FALLBACK_LABEL;
  const ruleById = new Map(rules.map((r) => [`${r.code}@${r.version}`, r]));

  const candidates = rules.map((r) => ({
    id: `${r.code}@${r.version}`,
    text: candidateText(r),
  }));

  const prepared = GOLD_QUERIES.map((q) => ({
    enterprise: q.enterprise,
    month: q.month,
    gold: [...q.gold].sort(),
    text: queryText(q, ruleById, label[q.enterprise] ?? q.enterprise),
  }));

  // 全体语料词表：候选文本 + 全部查询文本。
  const vocab = buildVocab([...candidates.map((c) => c.text), ...prepared.map((p) => p.text)]);
  const candidateVecs = candidates.map((c) => ({ id: c.id, vec: vectorize(c.text, vocab) }));

  const queries = prepared.map((p) => {
    const qVec = vectorize(p.text, vocab);
    // 全部候选按余弦降序；余弦相等时按 id 升序保证确定性。
    const ranked = candidateVecs
      .map((c) => ({ id: c.id, cosine: cosine(qVec, c.vec) }))
      .sort((a, b) => b.cosine - a.cosine || a.id.localeCompare(b.id));

    const topK = p.gold.length;
    const retrieved = ranked
      .slice(0, topK)
      .map((r) => r.id)
      .sort();
    const scores = ranked.map((r) => ({ id: r.id, cosine: round3(r.cosine) }));
    const metrics = prf(p.gold, retrieved);
    const versionExact = JSON.stringify(retrieved) === JSON.stringify(p.gold);

    return {
      enterprise: p.enterprise,
      month: p.month,
      gold: p.gold,
      retrieved,
      scores,
      ...metrics,
      versionExact,
    };
  });

  const n = queries.length;
  const macro = {
    precision: queries.reduce((a, q) => a + q.precision, 0) / n,
    recall: queries.reduce((a, q) => a + q.recall, 0) / n,
    f1: queries.reduce((a, q) => a + q.f1, 0) / n,
    topK: queries.reduce((a, q) => a + q.gold.length, 0) / n,
    queryCount: n,
    candidateCount: rules.length,
  };

  return {
    available: true,
    method:
      '诊断对照（非评分）：本地确定性字符/2-gram 哈希嵌入 + 余弦 top-K 玩具实验；存在 label leak、版本不可分、不稳健三处方法学缺陷，P/R/F1 无质量含义',
    disclaimer:
      '⚠️ 不是可信的向量化分数：项目无向量库/embedding 服务；本值仅为「若换向量检索会怎样」的可复算结构诊断，58.3% 只是有缺陷方法下的具体取值，不得用于衡量检索质量或横向比较。线上规则检索仍是确定性三重过滤。',
    macro,
    queries,
  };
}
