/**
 * 发票校验辅助工具包插件（ToolPackExtension）。
 *
 * 遵循扩展点安全契约：
 * 1. 插件注册的工具名称必须以 `_plugin` 结尾（白名单命名规范）
 * 2. 插件工具同样通过 `ToolExecutionContext` 拿企业与会话，严禁入参携带企业号
 */

import {
  definePlugin,
  type ExtensionRegistry,
  type PluginInstance,
  type ToolDefinition,
  type ToolPackExtension,
} from '@harness/contracts';
import { z } from 'zod';

export class InvoiceToolsPack implements ToolPackExtension {
  readonly kind = 'tool-pack' as const;

  tools(): readonly ToolDefinition[] {
    return [
      {
        name: 'validate_invoice_no_plugin',
        description: '校验发票编号格式是否符合标准编码规范（F加三位数字）',
        inputSchema: z.object({
          invoiceNo: z.string().describe('发票编号，如 F002'),
        }),
        execute: async (raw: unknown) => {
          const { invoiceNo } = raw as { invoiceNo: string };
          const isValid = /^F\d{3}$/.test(invoiceNo);
          return {
            ok: true,
            data: {
              invoiceNo,
              isValid,
              reason: isValid ? '编号格式合规' : '编号格式不合规（应形如 F001-F999）',
            },
          };
        },
      },
    ];
  }
}

export const invoiceToolsPlugin = definePlugin((_ctx) => {
  return {
    register(registry: ExtensionRegistry): void {
      registry.addToolPack(new InvoiceToolsPack());
    },
  } as PluginInstance;
});
