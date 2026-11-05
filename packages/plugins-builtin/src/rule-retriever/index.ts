/**
 * 规则候选检索插件（RuleRetrieverExtension）。
 *
 * 采用 2-gram 关键词切片检索。
 * 注意：检索插件只产出候选 `{ code, version, score }`，
 * 最终适用性永远由领域层 `selectApplicableRules` 严格按照生效日期与企业范围判定。
 */

import {
  definePlugin,
  type ExtensionRegistry,
  type PluginInstance,
  type RuleCandidate,
  type RuleRetrieverExtension,
} from '@harness/contracts';

function tokenize(text: string): Set<string> {
  const cleaned = text.replace(/[，。、；：？！\s]+/g, ' ').toLowerCase();
  const tokens = new Set<string>();
  for (const seg of cleaned.split(' ')) {
    if (!seg) continue;
    if (/[一-鿿]/.test(seg)) {
      for (let i = 0; i < seg.length - 1; i++) {
        tokens.add(seg.slice(i, i + 2));
      }
    } else {
      tokens.add(seg);
    }
  }
  return tokens;
}

export class KeywordRuleRetriever implements RuleRetrieverExtension {
  readonly kind = 'rule-retriever' as const;

  constructor(
    private readonly ruleStore: Array<{
      code: string;
      version: string;
      keywords: string[];
      title: string;
    }> = [
      {
        code: 'R001',
        version: '1.0',
        keywords: ['金额', '统计', '收入', '支出', '总额'],
        title: '金额统计说明',
      },
      {
        code: 'R002',
        version: '2.0',
        keywords: ['发票', '用途', '必填', '甲企业'],
        title: '甲企业发票用途规则',
      },
      {
        code: 'R003',
        version: '1.0',
        keywords: ['发票', '用途', '1000', '门槛', '乙企业'],
        title: '乙企业发票用途规则',
      },
      {
        code: 'R004',
        version: '1.0',
        keywords: ['银行', '流水', '只读', '资料'],
        title: '银行资料说明',
      },
    ],
  ) {}

  async search(query: { readonly text: string }): Promise<readonly RuleCandidate[]> {
    const tokens = tokenize(query.text);
    const results: RuleCandidate[] = [];

    for (const rule of this.ruleStore) {
      let score = 0;
      const matched: string[] = [];

      for (const kw of rule.keywords) {
        if (query.text.includes(kw)) {
          score += 2;
          matched.push(kw);
        }
      }

      for (const t of tokens) {
        if (rule.title.toLowerCase().includes(t)) {
          score += 1;
        }
      }

      if (score > 0) {
        results.push({
          code: rule.code,
          version: rule.version,
          score,
          matchedKeywords: matched,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }
}

export const ruleRetrieverPlugin = definePlugin((_ctx) => {
  return {
    register(registry: ExtensionRegistry): void {
      registry.addRuleRetriever(new KeywordRuleRetriever());
    },
  } as PluginInstance;
});
