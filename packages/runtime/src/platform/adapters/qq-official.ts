/**
 * QQ 官方机器人平台适配器（Webhook 模式）。
 *
 * 协议要点：
 * - 回调验签：**Ed25519**，`X-Signature-Ed25519` + `X-Signature-Timestamp`
 * - 首次配置时平台发 `op: 13` 的验证请求，需回应 plain_token
 * - 消息事件：`t === 'AT_MESSAGE_CREATE'` 或 `'GROUP_AT_MESSAGE_CREATE'`
 *
 * 实现说明：QQ 给的公钥是裸 32 字节 hex，需要包一层 SPKI DER 头
 * 才能被 Node 的 crypto 使用。
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

export interface QQOfficialConfig {
  readonly appId: string;
  readonly appSecret: string;
  readonly token: string;
  /** QQ 开放平台的 Ed25519 公钥（hex）。 */
  readonly publicKeyHex: string;
}

interface QQBody {
  readonly op?: number;
  readonly t?: string;
  readonly id?: string;
  readonly d?: {
    readonly id?: string;
    readonly content?: string;
    readonly plain_token?: string;
    readonly author?: { readonly id?: string; readonly username?: string };
    readonly channel_id?: string;
    readonly group_openid?: string;
  };
}

/** Ed25519 SPKI DER 前缀（固定 12 字节）。 */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifyEd25519(publicKeyHex: string, message: string, signatureHex: string): boolean {
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

export class QQOfficialCodec implements WebhookCodec {
  constructor(private readonly config: QQOfficialConfig) {}

  verify(req: WebhookRequest): boolean {
    const body = req.body as QQBody;
    // 回调地址验证（op:13）平台不做签名
    if (body.op === 13) return true;

    const sig = req.headers['x-signature-ed25519'];
    const ts = req.headers['x-signature-timestamp'];
    if (sig === undefined || ts === undefined) return false;

    // 未配置公钥时跳过（开发模式）；生产必须配置
    if (this.config.publicKeyHex === '') return true;

    return verifyEd25519(this.config.publicKeyHex, `${ts}${req.rawBody}`, sig);
  }

  decode(req: WebhookRequest): DecodedMessage | null {
    const body = req.body as QQBody;
    if (body.op === 13) return null;

    const eventType = body.t;
    if (eventType !== 'AT_MESSAGE_CREATE' && eventType !== 'GROUP_AT_MESSAGE_CREATE') {
      return null;
    }

    const text = (body.d?.content ?? '').trim();
    const authorId = body.d?.author?.id ?? '';
    if (text === '' || authorId === '') return null;

    return {
      platformUserId: authorId,
      text,
      messageId: body.id ?? body.d?.id ?? `qq_${Date.now()}`,
      replyContext: {
        channelId: body.d?.channel_id ?? '',
        groupOpenid: body.d?.group_openid ?? '',
      },
    };
  }

  encode(chunk: OutgoingChunk): unknown {
    const text =
      chunk.kind === 'done' ? chunk.text : chunk.kind === 'error' ? `[错误] ${chunk.message}` : '';
    return { content: text, msg_type: 0 };
  }
}

export class QQOfficialPlatform extends WebhookPlatform {
  constructor(config: QQOfficialConfig, platformId = 'qqofficial') {
    super(new QQOfficialCodec(config), platformId, 'qqofficial', 'QQ 官方机器人');
  }

  async handleWebhookSafe(req: WebhookRequest): Promise<WebhookResponse> {
    if (!this.codec.verify(req)) {
      return { status: 401, body: { error: 'invalid signature' } };
    }

    const body = req.body as QQBody;
    // 回调地址验证：原样回 plain_token
    if (body.op === 13) {
      return { status: 200, body: { plain_token: body.d?.plain_token ?? '' } };
    }

    const decoded = this.codec.decode(req);
    if (decoded === null) return { status: 200, body: { ok: true } };
    return { status: 200, body: { ok: true, messageId: decoded.messageId } };
  }
}
