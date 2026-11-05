/**
 * JSONL 运行记录导出插件（TraceSinkExtension）。
 *
 * 每次执行结束将运行快照单行追加写入目标缓冲区或回调，
 * 便于测试审查与离线回放。
 */

import {
  definePlugin,
  type ExtensionRegistry,
  type PluginInstance,
  type TraceSinkExtension,
} from '@harness/contracts';

export class JsonlTraceSink implements TraceSinkExtension {
  readonly kind = 'trace-sink' as const;
  readonly lines: string[] = [];

  constructor(private readonly onLine?: (line: string) => void) {}

  async write(run: unknown): Promise<void> {
    const line = JSON.stringify(run);
    this.lines.push(line);
    this.onLine?.(line);
  }

  async list(): Promise<unknown[]> {
    return this.lines.map((l) => JSON.parse(l) as unknown);
  }
}

export const jsonlTracePlugin = definePlugin((_ctx) => {
  return {
    register(registry: ExtensionRegistry): void {
      registry.addTraceSink(new JsonlTraceSink());
    },
  } as PluginInstance;
});
