/**
 * 钉钉（DingTalk）平台适配器。
 *
 * 协议要点：
 * - 回调验签：请求头 `timestamp` + `sign`，`sign = base64(HMAC-SHA256(timestamp + "\n" + appSecret))`
 * - 消息体：`{ msgtype: 'text', text: { content }, senderStaffId, msgId }`
 * - 回复：机器人通过 sessionWebhook 主动推送
 *
 * 参考：Harness `core/platform/sources/dingtalk/`
 */

import type { OutgoingChunk } from '../index.js';
import {
  type DecodedMessage,
  hmacSha256Base64,
  timingSafeEqual,
  type WebhookCodec,
  WebhookPlatform,
  type WebhookRequest,
  type WebhookResponse,
} from '../webhook.js';

export interface DingTalkConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** 机器人回调的签名密钥。 */
  readonly appSecret: string;
}

interface DingBody {
  readonly msgtype?: string;
  readonly msgId?: string;
  readonly text?: { readonly content?: string };
  readonly senderStaffId?: string;
  readonly senderNick?: string;
  readonly conversationId?: string;
  readonly sessionWebhook?: string;
}

export class DingTalkCodec implements WebhookCodec {
  constructor(private readonly config: DingTalkConfig) {}

  /** 同步验签不可行（HMAC 是异步的），实际用 verifyAsync。 */
  verify(_req: WebhookRequest): boolean {
    return true;
  }

  async verifyAsync(req: WebhookRequest): Promise<boolean> {
    const timestamp = req.headers.timestamp;
    const sign = req.headers.sign;
    if (timestamp === undefined || sign === undefined) return false;

    const expected = await hmacSha256Base64(
      this.config.appSecret,
      `${timestamp}\n${this.config.appSecret}`,
    );
    return timingSafeEqual(expected, sign);
  }

  decode(req: WebhookRequest): DecodedMessage | null {
    const body = req.body as DingBody;
    if (body.msgtype !== 'text') return null;

    const text = (body.text?.content ?? '').trim();
    if (text === '') return null;

    const staffId = body.senderStaffId ?? '';
    if (staffId === '') return null;

    return {
      platformUserId: staffId,
      text,
      messageId: body.msgId ?? `ding_${Date.now()}`,
      replyContext: {
        conversationId: body.conversationId ?? '',
        sessionWebhook: body.sessionWebhook ?? '',
      },
    };
  }

  encode(chunk: OutgoingChunk): unknown {
    const text =
      chunk.kind === 'done' ? chunk.text : chunk.kind === 'error' ? `[错误] ${chunk.message}` : '';
    return { msgtype: 'text', text: { content: text } };
  }
}

export class DingTalkPlatform extends WebhookPlatform {
  private readonly codecImpl: DingTalkCodec;

  constructor(config: DingTalkConfig, platformId = 'dingtalk') {
    const codec = new DingTalkCodec(config);
    super(codec, platformId, 'dingtalk', '钉钉');
    this.codecImpl = codec;
  }

  async handleWebhookSafe(req: WebhookRequest): Promise<WebhookResponse> {
    if (!(await this.codecImpl.verifyAsync(req))) {
      return { status: 401, body: { error: 'invalid signature' } };
    }
    const decoded = this.codecImpl.decode(req);
    if (decoded === null) return { status: 200, body: { ok: true } };
    return { status: 200, body: { ok: true, messageId: decoded.messageId } };
  }
}
