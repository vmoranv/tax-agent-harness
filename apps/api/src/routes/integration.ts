/**
 * 模型服务商 (Provider) 与消息渠道 (Platform) 管理端点。
 */

import { getPreset, listVendors, type ProtocolId, resolveProvider } from '@harness/runtime';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getEnv, llmConfig } from '../env.js';
import type { Runtime } from '../runtime-factory.js';

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  const rt = (): Runtime => (app as unknown as { runtime: Runtime }).runtime;

  // 1. 获取 Provider 信息与厂商预设列表
  app.get('/providers', async () => {
    const runtime = rt();
    const vendors = listVendors().map((v) => {
      const preset = getPreset(v.id);
      return {
        id: v.id,
        label: v.label,
        protocol: v.protocol,
        supportsTools: v.supportsTools,
        baseUrl: preset?.baseUrl ?? '',
        defaultModel: preset?.defaultModel ?? '',
      };
    });

    const llm = llmConfig();
    return {
      current: {
        configured: runtime.llm.configured,
        vendor: runtime.llm.vendor,
        model: runtime.llm.model,
        baseUrl: llm.baseUrl,
      },
      vendors,
    };
  });

  // 2. 测试 Provider 连通性
  const TestProviderSchema = z.object({
    vendor: z.string().optional(),
    protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic', 'gemini']).optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().min(1),
    model: z.string().optional(),
  });

  app.post('/providers/test', async (req, reply) => {
    const parsed = TestProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        ok: false,
        message: `参数校验失败: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      });
    }

    const { vendor, protocol, baseUrl, apiKey, model } = parsed.data;
    const t0 = Date.now();
    try {
      const resolved = resolveProvider({
        vendor,
        protocol: protocol as ProtocolId,
        baseUrl,
        apiKey,
        model,
        timeoutMs: 8_000,
      });

      return reply.send({
        ok: true,
        latencyMs: Date.now() - t0,
        model: resolved.modelId,
        protocol: resolved.protocol,
        message: '配置解析通过，适配器初始化成功',
      });
    } catch (err) {
      return reply.send({
        ok: false,
        latencyMs: Date.now() - t0,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 3. 获取 IM 平台适配器信息
  app.get('/platforms', async () => {
    const platforms = [
      {
        id: 'lark',
        name: '飞书 (Lark)',
        type: 'webhook',
        category: 'im',
        icon: 'mdi-feather',
        authType: 'SHA-256 签名 (ts+nonce+encryptKey+body)',
        webhookPath: '/api/webhook/lark',
        status: getEnv('LARK_APP_ID') !== '' ? 'running' : 'ready',
        description: '支持飞书企业自建应用、事件订阅、富文本卡片交互与群聊会话绑定。',
        features: ['消息加密', '群聊@机器人', '单聊交互', '防重放攻击'],
        configFields: [
          {
            key: 'appId',
            label: 'App ID (cli_xxx)',
            required: true,
            placeholder: 'cli_a1b2c3d4e5',
          },
          {
            key: 'appSecret',
            label: 'App Secret',
            required: true,
            secret: true,
            placeholder: '••••••••',
          },
          {
            key: 'encryptKey',
            label: 'Encrypt Key (加密秘钥)',
            required: false,
            secret: true,
            placeholder: '选填，加密事件必填',
          },
          {
            key: 'verificationToken',
            label: 'Verification Token',
            required: true,
            secret: true,
            placeholder: '••••••••',
          },
        ],
      },
      {
        id: 'dingtalk',
        name: '钉钉 (DingTalk)',
        type: 'webhook',
        category: 'im',
        icon: 'mdi-bullhorn-outline',
        authType: 'HMAC-SHA256 签名 (ts+secret)',
        webhookPath: '/api/webhook/dingtalk',
        status: getEnv('DINGTALK_CLIENT_ID') !== '' ? 'running' : 'ready',
        description: '支持钉钉企业内部机器人、单聊、群聊消息流转与 Markdown 渲染。',
        features: ['时间戳防篡改', '群聊艾特', '会话上下文', 'ActionCard'],
        configFields: [
          { key: 'clientId', label: 'Client ID (AppKey)', required: true, placeholder: 'dingxxx' },
          {
            key: 'clientSecret',
            label: 'Client Secret (AppSecret)',
            required: true,
            secret: true,
            placeholder: '••••••••',
          },
          {
            key: 'robotCode',
            label: 'Robot Code (机器人标识)',
            required: false,
            placeholder: '选填',
          },
        ],
      },
      {
        id: 'wecom',
        name: '企业微信 (WeCom)',
        type: 'webhook',
        category: 'im',
        icon: 'mdi-wechat',
        authType: 'SHA-1 签名 (token+ts+nonce) + XML 消息',
        webhookPath: '/api/webhook/wecom',
        status: getEnv('WECOM_CORP_ID') !== '' ? 'running' : 'ready',
        description: '支持企微自建应用与智能机器人回调，原生 CDATA XML 编解码。',
        features: ['XML 结构解析', '多企业会话隔离', '消息加解密', '主动推送'],
        configFields: [
          { key: 'corpId', label: '企业 ID (CorpID)', required: true, placeholder: 'ww1234567890' },
          { key: 'agentId', label: '应用 AgentId', required: true, placeholder: '1000002' },
          {
            key: 'token',
            label: '回调 Token',
            required: true,
            secret: true,
            placeholder: '••••••••',
          },
          {
            key: 'encodingAesKey',
            label: 'EncodingAESKey',
            required: true,
            secret: true,
            placeholder: '43位Base64字符',
          },
        ],
      },
      {
        id: 'qqofficial',
        name: 'QQ 开放平台',
        type: 'webhook',
        category: 'im',
        icon: 'mdi-qqchat',
        authType: 'Ed25519 签名 (SPKI DER 包装公钥)',
        webhookPath: '/api/webhook/qq',
        status: getEnv('QQ_BOT_APP_ID') !== '' ? 'running' : 'ready',
        description:
          'QQ 官方频道机器人与群聊接入，支持 Ed25519 纯二进制安全验签与 op:13 免签心跳。',
        features: ['Ed25519 验签', 'timingSafeEqual', '单聊/群聊', '频道消息'],
        configFields: [
          { key: 'appId', label: 'Bot AppID', required: true, placeholder: '10203040' },
          {
            key: 'clientSecret',
            label: 'Client Secret',
            required: true,
            secret: true,
            placeholder: '••••••••',
          },
          {
            key: 'botToken',
            label: 'Bot Token',
            required: true,
            secret: true,
            placeholder: '••••••••',
          },
        ],
      },
      {
        id: 'telegram',
        name: 'Telegram Bot',
        type: 'polling/webhook',
        category: 'im',
        icon: 'mdi-send',
        authType: 'Bot Token 显式身份绑定 (chatBindings)',
        webhookPath: '/api/webhook/telegram',
        status: getEnv('TELEGRAM_BOT_TOKEN') !== '' ? 'running' : 'ready',
        description:
          '支持 Telegram Bot 长轮询 (Long Polling) 与 Webhook 双模式，内置 chatBindings 跨企业映射。',
        features: ['长轮询自恢复', 'ChatID 绑定', 'MarkdownV2 渲染', '命令菜单'],
        configFields: [
          {
            key: 'botToken',
            label: 'Bot Token',
            required: true,
            secret: true,
            placeholder: '123456789:ABCdefGhIJKlmNoPQR',
          },
          { key: 'mode', label: '接入模式', required: true, placeholder: 'polling 或 webhook' },
        ],
      },
      {
        id: 'discord',
        name: 'Discord Bot',
        type: 'webhook',
        category: 'im',
        icon: 'mdi-discord',
        authType: 'ED25519 签名验证',
        webhookPath: '/api/webhook/discord',
        status: 'ready',
        description: '支持 Discord Interactions Webhook 回调与频道即时消息响应。',
        features: ['Slash Commands', '频道交互', 'Embed 消息卡片'],
        configFields: [
          {
            key: 'applicationId',
            label: 'Application ID',
            required: true,
            placeholder: '123456789012345678',
          },
          {
            key: 'publicKey',
            label: 'Public Key',
            required: true,
            secret: true,
            placeholder: '64位Hex字符串',
          },
          {
            key: 'botToken',
            label: 'Bot Token',
            required: true,
            secret: true,
            placeholder: '••••••••',
          },
        ],
      },
      {
        id: 'slack',
        name: 'Slack App',
        type: 'webhook',
        category: 'im',
        icon: 'mdi-slack',
        authType: 'HMAC-SHA256 签名 (v0:timestamp:body)',
        webhookPath: '/api/webhook/slack',
        status: 'ready',
        description: '支持 Slack Events API 与 Block Kit 结构化报表推送。',
        features: ['Block Kit 交互', '事件订阅', '防重放攻击'],
        configFields: [
          { key: 'clientId', label: 'Client ID', required: true, placeholder: '1234567.890123' },
          {
            key: 'clientSecret',
            label: 'Client Secret',
            required: true,
            secret: true,
            placeholder: '••••••••',
          },
          {
            key: 'signingSecret',
            label: 'Signing Secret',
            required: true,
            secret: true,
            placeholder: '••••••••',
          },
        ],
      },
    ];

    return { platforms };
  });
}
