/**
 * 去 AI 味回复渲染插件（ReplyRendererExtension）。
 *
 * 规则清洗：
 * 1. 删除客套开头：「好的」「当然可以」「没问题」等
 * 2. 删除套话结尾：「希望对您有所帮助」「如有其他问题随时告知」等
 * 3. 压缩过度空行
 * 4. 保证账务数据原样保留，绝不篡改数值字面量
 */

import {
  type DraftReply,
  definePlugin,
  type ExtensionRegistry,
  type PluginInstance,
  type RenderedReply,
  type ReplyRendererExtension,
} from '@harness/contracts';

const AI_OPENINGS = [
  /^(好的|当然|没问题|收到|为您查询到|请稍候|已为您整理)[，,。!！\s]*/i,
  /^(根据您提供的信息|按照您的要求)[，,。!！\s]*/i,
];

const AI_CLOSINGS = [
  /(希望以上信息对您(?:有所)?帮助[。！!]?)$/i,
  /(如有(?:任何)?其他(?:疑问|问题|需要)，?请?随时(?:联系|告知|提出|提问)[。！!]?)$/i,
  /(感谢您的咨询[。！!]?)$/i,
];

export function cleanAiFluff(text: string): string {
  let cleaned = text.trim();

  // 清洗开头客套
  for (const pattern of AI_OPENINGS) {
    cleaned = cleaned.replace(pattern, '').trim();
  }

  // 清洗结尾客套
  for (const pattern of AI_CLOSINGS) {
    cleaned = cleaned.replace(pattern, '').trim();
  }

  // 压缩 3 个以上的连续换行
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned;
}

export class CleanReplyRenderer implements ReplyRendererExtension {
  readonly kind = 'reply-renderer' as const;
  readonly rendererId = 'clean-style';

  async render(draft: DraftReply): Promise<RenderedReply> {
    return {
      text: cleanAiFluff(draft.text),
    };
  }
}

export const replyStylePlugin = definePlugin((_ctx) => {
  return {
    register(registry: ExtensionRegistry): void {
      registry.addReplyRenderer(new CleanReplyRenderer());
    },
  } as PluginInstance;
});
