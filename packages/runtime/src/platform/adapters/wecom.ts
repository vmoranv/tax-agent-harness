/**
 * 企业微信平台适配器。
 *
 * 协议要点：
 * - 回调验签：`msg_signature = sha1(sort(token, timestamp, nonce).join(''))`
 * - 消息体是 **XML**（不是 JSON），需解析 `<Content>` 与 `<FromUserName>`
 * - 回复：被动回复 XML，或主动调用 send API
 *
 * 参考：Harness `core/platform/sources/wecom/`
 */

import { createHash } from 'node:crypto';
import type { OutgoingChunk } from '../index.js';
import {
  type DecodedMessage,
  timingSafeEqual,
  type WebhookCodec,
  WebhookPlatform,
  type WebhookRequest,
  type WebhookResponse,
} from '../webhook.js';

export interface WecomConfig {
  readonly corpId: string;
  readonly agentId: string;
  readonly secret: string;
  readonly token: string;
  readonly encodingAesKey: string;
}

/** 企业微信用 SHA-1，不是 SHA-256。 */
function sha1Hex(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex');
}

/** 从 XML 里取标签值。企微消息是 XML，用正则足够（不引第三方解析器）。 */
function xmlValue(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`);
  const m = re.exec(xml);
  return m?.[1] ?? '';
}

export class WecomCodec implements WebhookCodec {
  constructor(private readonly config: WecomConfig) {}

  verify(req: WebhookRequest): boolean {
    const signature = req.headers.msg_signature;
    const timestamp = req.headers.timestamp;
    const nonce = req.headers.nonce;
    if (signature === undefined || timestamp === undefined || nonce === undefined) {
      return false;
    }

    // 企微规则：token / timestamp / nonce 字典序排序后拼接再 sha1
    const expected = sha1Hex([this.config.token, timestamp, nonce].sort().join(''));
    return timingSafeEqual(expected, signature);
  }

  decode(req: WebhookRequest): DecodedMessage | null {
    const xml = req.rawBody;
    if (xmlValue(xml, 'MsgType') !== 'text') return null;

    const content = xmlValue(xml, 'Content').trim();
    const fromUser = xmlValue(xml, 'FromUserName');
    if (content === '' || fromUser === '') return null;

    return {
      platformUserId: fromUser,
      text: content,
      messageId: xmlValue(xml, 'MsgId') || `wecom_${Date.now()}`,
      replyContext: { fromUser },
    };
  }

  encode(chunk: OutgoingChunk): string {
    const text =
      chunk.kind === 'done' ? chunk.text : chunk.kind === 'error' ? `[错误] ${chunk.message}` : '';
    return `<xml><Content><![CDATA[${text}]]></Content></xml>`;
  }
}

export class WecomPlatform extends WebhookPlatform {
  constructor(config: WecomConfig, platformId = 'wecom') {
    super(new WecomCodec(config), platformId, 'wecom', '企业微信');
  }

  async handleWebhookSafe(req: WebhookRequest): Promise<WebhookResponse> {
    if (!this.codec.verify(req)) {
      return { status: 401, body: 'invalid signature' };
    }
    const decoded = this.codec.decode(req);
    if (decoded === null) return { status: 200, body: '' };
    return { status: 200, body: '', messageId: decoded.messageId } as WebhookResponse;
  }
}
