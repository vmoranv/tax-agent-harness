/**
 * `@harness/plugins-builtin` 公共出口。
 *
 * 实现了规范中的 4 个内置扩展点：
 * 1. `builtin/reply-style`   (ReplyRendererExtension)
 * 2. `builtin/rule-retriever` (RuleRetrieverExtension)
 * 3. `builtin/jsonl-trace`    (TraceSinkExtension)
 * 4. `builtin/invoice-tools`  (ToolPackExtension)
 */

export * from './invoice-tools/index.js';
export * from './jsonl-trace/index.js';
export * from './reply-style/index.js';
export * from './rule-retriever/index.js';

import type { ExtensionRegistry } from '@harness/contracts';
import { InvoiceToolsPack } from './invoice-tools/index.js';
import { JsonlTraceSink } from './jsonl-trace/index.js';
import { CleanReplyRenderer } from './reply-style/index.js';
import { KeywordRuleRetriever } from './rule-retriever/index.js';

/** 一键注册全部内置扩展点。 */
export function registerAllBuiltins(registry: ExtensionRegistry): void {
  registry.addReplyRenderer(new CleanReplyRenderer());
  registry.addRuleRetriever(new KeywordRuleRetriever());
  registry.addTraceSink(new JsonlTraceSink());
  registry.addToolPack(new InvoiceToolsPack());
}
