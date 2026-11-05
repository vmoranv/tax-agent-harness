/**
 * 飞书（Lark）平台适配器。
 *
 * 协议要点：
 * - 回调验签：`sha256(timestamp + nonce + encrypt_key + body)`，与请求头 `X-Lark-Signature` 比对
 * - URL 验证：body 里带 `challenge`，需原样返回
 * - 消息事件：`header.event_type === 'im.message.receive_v1'`
 * - 文本内容：`event.message.content` 是 JSON 字符串 `{"text":"..."}`
 *
 * 参考：Harness `core/platform/sources/lark/`
 */

import type { OutgoingChunk } from '../index.js';
import {
  type DecodedMessage,
  sha256Hex,
  timingSafeEqual,
  type WebhookCodec,
  WebhookPlatform,
  type WebhookRequest,
} from '../webhook.js';

export interface LarkConfig {
  readonly appId: string;
  readonly appSecret: string;
  /** 事件订阅的 Encrypt Key；未开启加密时为空。 */
  readonly encryptKey?: string;
  /** 验证令牌。 */
  readonly verificationToken?: string;
}

interface LarkEventBody {
  readonly challenge?: string;
  readonly header?: {
    readonly event_type?: string;
    readonly event_id?: string;
    readonly token?: string;
  };
  readonly event?: {
    readonly message?: {
      readonly message_id?: string;
      readonly chat_id?: string;
      readonly message_type?: string;
      readonly content?: string;
    };
    readonly sender?: {
      readonly sender_id?: { readonly open_id?: string; readonly user_id?: string };
    };
  };
}

export class LarkCodec implements WebhookCodec {
  constructor(private readonly config: LarkConfig) {}

  verify(req: WebhookRequest): boolean {
    // URL 验证请求不要求签名
    const body = req.body as LarkEventBody;
    if (body.challenge !== undefined) return true;

    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];

    if (signature === undefined || timestamp === undefined || nonce === undefined) {
      return false;
    }

    // 未配置 encryptKey 时无法验签，按「不校验」处理（开发模式）
    if (this.config.encryptKey === undefined || this.config.encryptKey === '') {
      return true;
    }

    // 同步验签需要异步摘要，这里用已预计算的同步路径不可行；
    // 实际由 handleWebhookAsync 完成，见 verifyAsync
    return true;
  }

  /** 异步验签（推荐路径）。 */
  async verifyAsync(req: WebhookRequest): Promise<boolean> {
    const body = req.body as LarkEventBody;
    if (body.challenge !== undefined) return true;

    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];

    if (signature === undefined || timestamp === undefined || nonce === undefined) return false;
    if (this.config.encryptKey === undefined || this.config.encryptKey === '') return true;

    const expected = await sha256Hex(`${timestamp}${nonce}${this.config.encryptKey}${req.rawBody}`);
    return timingSafeEqual(expected, signature);
  }

  decode(req: WebhookRequest): DecodedMessage | null {
    const body = req.body as LarkEventBody;

    // URL 验证：返回 challenge 由上层处理
    if (body.challenge !== undefined) return null;

    const eventType = body.header?.event_type;
    if (eventType !== 'im.message.receive_v1') return null;

    const msg = body.event?.message;
    if (msg === undefined || msg.message_type !== 'text') return null;

    const openId = body.event?.sender?.sender_id?.open_id ?? '';
    if (openId === '') return null;

    let text = '';
    try {
      const parsed = JSON.parse(msg.content ?? '{}') as { text?: string };
      text = (parsed.text ?? '').trim();
    } catch {
      return null;
    }
    if (text === '') return null;

    return {
      platformUserId: openId,
      text,
      messageId: msg.message_id ?? `lark_${Date.now()}`,
      replyContext: {
        chatId: msg.chat_id ?? '',
        messageId: msg.message_id ?? '',
      },
    };
  }

  encode(chunk: OutgoingChunk): unknown {
    if (chunk.kind === 'done') {
      return { msg_type: 'text', content: { text: chunk.text } };
    }
    if (chunk.kind === 'error') {
      return { msg_type: 'text', content: { text: `[错误] ${chunk.message}` } };
    }
    return { msg_type: 'text', content: { text: '' } };
  }
}

export class LarkPlatform extends WebhookPlatform {
  private readonly codecImpl: LarkCodec;

  constructor(config: LarkConfig, platformId = 'lark') {
    const codec = new LarkCodec(config);
    super(codec, platformId, 'lark', '飞书');
    this.codecImpl = codec;
  }

  /** 覆盖基类：用异步验签。 */
  async handleWebhookSafe(req: WebhookRequest): Promise<{ status: number; body: unknown }> {
    if (!(await this.codecImpl.verifyAsync(req))) {
      return { status: 401, body: { error: 'invalid signature' } };
    }

    const body = req.body as LarkEventBody;
    // URL 验证：原样返回 challenge
    if (body.challenge !== undefined) {
      return { status: 200, body: { challenge: body.challenge } };
    }

    const decoded = this.codecImpl.decode(req);
    if (decoded === null) return { status: 200, body: { ok: true } };
    return { status: 200, body: { ok: true, messageId: decoded.messageId } };
  }
}
