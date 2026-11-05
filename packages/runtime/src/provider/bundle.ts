/**
 * Provider 装配（单一实现）。
 *
 * 此前 api/runtime-factory、worker/worker、cli/bootstrap 三处各写了一遍
 * 「new ProviderManager → 读配置 → 判 hasLlm → 造 createModel/modelId/providerId」
 * 的相同逻辑（jscpd 报的架构性重复之一）。这里收敛为唯一入口：
 * 三个进程都调用 `createProviderBundle()`，行为一致，密钥只从 ProviderConfig 进入。
 */
import type { LanguageModel } from 'ai';
import { type ProviderConfig, ProviderManager, providerConfigFromEnv } from './index.js';

export interface ProviderBundle {
  /** 是否配置了可用的 LLM（baseUrl 与 apiKey 均非空）。 */
  readonly configured: boolean;
  /** 未配置时调用会抛「模型未配置」，与 Harness.createModel 契约一致。 */
  readonly createModel: () => LanguageModel;
  readonly modelId: string;
  readonly providerId: string;
  readonly manager: ProviderManager;
}

/**
 * 装配模型 provider。
 * @param cfg 显式配置；不传时从环境变量读取（providerConfigFromEnv）。
 */
export async function createProviderBundle(
  cfg: ProviderConfig = providerConfigFromEnv(),
): Promise<ProviderBundle> {
  const manager = new ProviderManager();
  const configured = cfg.baseUrl !== '' && cfg.apiKey !== '';

  if (!configured) {
    return {
      configured,
      createModel: (): LanguageModel => {
        throw new Error('模型未配置');
      },
      modelId: 'none',
      providerId: 'none',
      manager,
    };
  }

  const p = await manager.load(cfg);
  return {
    configured,
    createModel: (): LanguageModel => p.createModel(),
    modelId: p.meta().defaultModel,
    providerId: p.meta().type,
    manager,
  };
}
