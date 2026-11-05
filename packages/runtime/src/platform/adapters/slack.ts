/**
 * Slack 平台适配器（Events API Webhook）。
 *
 * 协议要点：
 * - 验签：`X-Slack-Signature` = `v0=` + hex(HMAC-SHA256(`v0:${timestamp}:${rawBody}`, signingSecret))
 * - 防重放：时间戳偏差 > 5 分钟直接拒绝
 * - 首次 URL 验证：收到 `type: 'url_verification'`，原样回传 `{ challenge }`
 * - 消息事件：`type === 'event_callback'` 且 `event.type === 'message'`
 */

import { createHmac } from 'node:crypto';
import type { OutgoingChunk } from '../index.js';
import {
  type DecodedMessage,
  timingSafeEqual,
  type WebhookCodec,
  WebhookPlatform,
  type WebhookRequest,
  type WebhookResponse,
} from '../webhook.js';

export interface SlackConfig {
  readonly signingSecret: string;
  readonly botToken?: string;
}

interface SlackBody {
  readonly type?: string;
  readonly challenge?: string;
  readonly event?: {
    readonly type?: string;
    readonly user?: string;
    readonly text?: string;
    readonly channel?: string;
    readonly ts?: string;
    readonly bot_id?: string;
  };
}

export class SlackCodec implements WebhookCodec {
  constructor(private readonly config: SlackConfig) {}

  verify(req: WebhookRequest): boolean {
    const body = req.body as SlackBody;
    // URL 验证请求免除 HMAC 校验以完成开放平台握手
    if (body.type === 'url_verification') return true;

    const signature = req.headers['x-slack-signature'];
    const timestampStr = req.headers['x-slack-request-timestamp'];
    if (!signature || !timestampStr) return false;

    // 防重放：超过 300 秒拒绝
    const ts = Number(timestampStr);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > 300) return false;

    if (!this.config.signingSecret) return true;

    const sigBasestring = `v0:${timestampStr}:${req.rawBody}`;
    const hmac = createHmac('sha256', this.config.signingSecret);
    hmac.update(sigBasestring);
    const expected = `v0=${hmac.digest('hex')}`;

    return timingSafeEqual(expected, signature);
  }

  decode(req: WebhookRequest): DecodedMessage | null {
    const body = req.body as SlackBody;
    if (body.type === 'url_verification') return null;

    if (body.type !== 'event_callback' || body.event?.type !== 'message') {
      return null;
    }

    // 忽略机器人自身产生的回环消息
    if (body.event.bot_id) return null;

    const text = (body.event.text ?? '').trim();
    const user = body.event.user ?? '';
    if (!text || !user) return null;

    return {
      platformUserId: user,
      text,
      messageId: body.event.ts ?? `slack_${Date.now()}`,
      replyContext: {
        channel: body.event.channel ?? '',
        threadTs: body.event.ts ?? '',
      },
    };
  }

  encode(chunk: OutgoingChunk): unknown {
    const text =
      chunk.kind === 'done' ? chunk.text : chunk.kind === 'error' ? `[错误] ${chunk.message}` : '';
    return { text };
  }
}

export class SlackPlatform extends WebhookPlatform {
  private readonly codecImpl: SlackCodec;

  constructor(config: SlackConfig, platformId = 'slack') {
    const codec = new SlackCodec(config);
    super(codec, platformId, 'slack', 'Slack');
    this.codecImpl = codec;
  }

  async handleWebhookSafe(req: WebhookRequest): Promise<WebhookResponse> {
    if (!this.codecImpl.verify(req)) {
      return { status: 401, body: { error: 'invalid signature' } };
    }

    const body = req.body as SlackBody;
    if (body.type === 'url_verification') {
      return { status: 200, body: { challenge: body.challenge ?? '' } };
    }

    const decoded = this.codecImpl.decode(req);
    if (decoded === null) return { status: 200, body: { ok: true } };
    return { status: 200, body: { ok: true, messageId: decoded.messageId } };
  }
}
