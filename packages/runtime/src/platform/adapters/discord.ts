/**
 * Discord 平台适配器（Interactions Webhook）。
 *
 * 协议要点：
 * - 验签：**Ed25519** 签名校验，头：`X-Signature-Ed25519` + `X-Signature-Timestamp`
 * - 握手：收到 `type: 1` (PING) 时，必须立即回应 `{ type: 1 }` (PONG)
 * - 消息交互：`type: 2` (APPLICATION_COMMAND) 等交互
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { OutgoingChunk } from '../index.js';
import {
  type DecodedMessage,
  type WebhookCodec,
  WebhookPlatform,
  type WebhookRequest,
  type WebhookResponse,
} from '../webhook.js';

export interface DiscordConfig {
  readonly applicationId: string;
  readonly botToken: string;
  /** Discord Application 页面公开的 Public Key（64 位 hex 字符串）。 */
  readonly publicKeyHex: string;
}

interface DiscordBody {
  readonly type?: number;
  readonly id?: string;
  readonly data?: {
    readonly name?: string;
    readonly options?: Array<{ readonly name: string; readonly value: unknown }>;
  };
  readonly member?: {
    readonly user?: { readonly id?: string; readonly username?: string };
  };
  readonly user?: { readonly id?: string; readonly username?: string };
  readonly channel_id?: string;
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifyDiscordEd25519(
  publicKeyHex: string,
  message: string,
  signatureHex: string,
): boolean {
  try {
    const raw = Buffer.from(publicKeyHex, 'hex');
    if (raw.length !== 32) return false;

    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });

    return cryptoVerify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

export class DiscordCodec implements WebhookCodec {
  constructor(private readonly config: DiscordConfig) {}

  verify(req: WebhookRequest): boolean {
    const sig = req.headers['x-signature-ed25519'];
    const ts = req.headers['x-signature-timestamp'];
    if (!sig || !ts) return false;

    if (!this.config.publicKeyHex) return true;

    return verifyDiscordEd25519(this.config.publicKeyHex, `${ts}${req.rawBody}`, sig);
  }

  decode(req: WebhookRequest): DecodedMessage | null {
    const body = req.body as DiscordBody;
    // PING 握手
    if (body.type === 1) return null;

    // 提取用户指令
    const authorId = body.member?.user?.id ?? body.user?.id ?? '';
    if (!authorId) return null;

    let text = '';
    if (body.data?.options && body.data.options.length > 0) {
      text = String(body.data.options[0]?.value ?? '').trim();
    } else if (body.data?.name) {
      text = body.data.name;
    }

    if (!text) return null;

    return {
      platformUserId: authorId,
      text,
      messageId: body.id ?? `discord_${Date.now()}`,
      replyContext: {
        channelId: body.channel_id ?? '',
        interactionId: body.id ?? '',
      },
    };
  }

  encode(chunk: OutgoingChunk): unknown {
    const content =
      chunk.kind === 'done' ? chunk.text : chunk.kind === 'error' ? `[错误] ${chunk.message}` : '';
    // Discord Interaction 回复格式: type 4 = CHANNEL_MESSAGE_WITH_SOURCE
    return {
      type: 4,
      data: { content },
    };
  }
}

export class DiscordPlatform extends WebhookPlatform {
  private readonly codecImpl: DiscordCodec;

  constructor(config: DiscordConfig, platformId = 'discord') {
    const codec = new DiscordCodec(config);
    super(codec, platformId, 'discord', 'Discord');
    this.codecImpl = codec;
  }

  async handleWebhookSafe(req: WebhookRequest): Promise<WebhookResponse> {
    if (!this.codecImpl.verify(req)) {
      return { status: 401, body: { error: 'invalid signature' } };
    }

    const body = req.body as DiscordBody;
    // PING 握手回应 PONG (type 1)
    if (body.type === 1) {
      return { status: 200, body: { type: 1 } };
    }

    const decoded = this.codecImpl.decode(req);
    if (decoded === null) return { status: 200, body: { ok: true } };
    return { status: 200, body: { ok: true, messageId: decoded.messageId } };
  }
}
