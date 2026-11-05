import { ExtensionRegistry } from '@harness/contracts';
import { describe, expect, it } from 'vitest';
import {
  CleanReplyRenderer,
  cleanAiFluff,
  InvoiceToolsPack,
  JsonlTraceSink,
  KeywordRuleRetriever,
  registerAllBuiltins,
} from '../src/index.js';

describe('reply-style 插件', () => {
  it('剥离客套开头与结尾', () => {
    const raw = '好的，甲企业 2026 年 9 月发票合计 9,622.06 元。希望以上信息对您有所帮助！';
    const cleaned = cleanAiFluff(raw);
    expect(cleaned).toBe('甲企业 2026 年 9 月发票合计 9,622.06 元。');
  });

  it('保留正文中的金额与账务内容', () => {
    const raw = '为您查询到：银行支出 7,180.74 元，收入 13,000.50 元。\n如有其他问题请随时告知！';
    const cleaned = cleanAiFluff(raw);
    expect(cleaned).toContain('7,180.74');
    expect(cleaned).toContain('13,000.50');
    expect(cleaned).not.toContain('为您查询到');
    expect(cleaned).not.toContain('如有其他问题');
  });

  it('CleanReplyRenderer 实现 ReplyRendererExtension 接口', async () => {
    const renderer = new CleanReplyRenderer();
    expect(renderer.kind).toBe('reply-renderer');
    const res = await renderer.render({ text: '好的，测试完成。', provenance: [] });
    expect(res.text).toBe('测试完成。');
  });
});

describe('rule-retriever 插件', () => {
  it('按关键词召回相关规则候选', async () => {
    const retriever = new KeywordRuleRetriever();
    expect(retriever.kind).toBe('rule-retriever');

    const candidates = await retriever.search({ text: '甲企业发票必须填用途吗' });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.code).toBe('R002');
    expect(candidates[0]?.matchedKeywords).toContain('用途');
  });

  it('无匹配时返回空列表', async () => {
    const retriever = new KeywordRuleRetriever();
    const candidates = await retriever.search({ text: '天气预报' });
    expect(candidates).toEqual([]);
  });
});

describe('jsonl-trace 插件', () => {
  it('追加写入并可列表回放', async () => {
    const written: string[] = [];
    const sink = new JsonlTraceSink((line) => written.push(line));
    expect(sink.kind).toBe('trace-sink');

    await sink.write({ runId: 'run_1', status: 'ok' });
    expect(sink.lines).toHaveLength(1);
    expect(written).toHaveLength(1);

    const list = await sink.list();
    expect(list[0]).toEqual({ runId: 'run_1', status: 'ok' });
  });
});

describe('invoice-tools 插件', () => {
  it('提供以 _plugin 结尾的安全工具', async () => {
    const pack = new InvoiceToolsPack();
    expect(pack.kind).toBe('tool-pack');

    const tools = pack.tools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('validate_invoice_no_plugin');

    const validRes = await tools[0]?.execute(
      { invoiceNo: 'F002' },
      {
        runId: 'r',
        toolCallId: 'c',
        userId: 'u',
        enterpriseId: 'e',
      },
    );
    expect(validRes.ok).toBe(true);
    expect((validRes.data as { isValid: boolean }).isValid).toBe(true);

    const invalidRes = await tools[0]?.execute(
      { invoiceNo: 'BAD_123' },
      {
        runId: 'r',
        toolCallId: 'c',
        userId: 'u',
        enterpriseId: 'e',
      },
    );
    expect((invalidRes.data as { isValid: boolean }).isValid).toBe(false);
  });
});

describe('registerAllBuiltins', () => {
  it('一键装配所有扩展点', () => {
    const reg = new ExtensionRegistry();
    registerAllBuiltins(reg);

    const summary = reg.summary();
    expect(summary['reply-renderer']).toContain('clean-style');
    expect(summary['tool-pack']).toContain('validate_invoice_no_plugin');
    expect(summary['rule-retriever']).toHaveLength(1);
    expect(summary['trace-sink']).toHaveLength(1);
  });
});
