/**
 * Webhook 类平台适配器的公共骨架。
 *
 * 飞书 / 钉钉 / 企微 / QQ官方 都是「HTTP 回调 + 签名校验 + 消息编解码」，
 * 差异只在三处：签名算法、消息结构、回复方式。
 *
 * 抽成模板后，每个平台只需实现：
 * - `verify(signature, timestamp, nonce, body)` 签名校验
 * - `decode(payload)` 平台消息 → 统一 IncomingMessage
 * - `encode(text)` 统一回复 → 平台消息
 */

import type {
  MessageEvent,
  OutgoingChunk,
  PlatformAdapter,
  PlatformMeta,
  PlatformStatus,
} from './index.js';

export interface WebhookRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
  readonly rawBody: string;
}

export interface WebhookResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * 平台特有的三件事。
 */
export interface WebhookCodec {
  /** 校验签名；不通过则拒绝。 */
  verify(req: WebhookRequest): boolean;
  /** 平台消息 → 统一事件；非消息事件返回 null（如加入群聊通知）。 */
  decode(req: WebhookRequest): DecodedMessage | null;
  /** 统一回复 → 平台响应体。 */
  encode(chunk: OutgoingChunk): unknown;
}

export interface DecodedMessage {
  readonly platformUserId: string;
  readonly text: string;
  readonly messageId: string;
  /** 回复时要用的上下文（如 reply_token、conversation_id）。 */
  readonly replyContext: Readonly<Record<string, string>>;
}

/**
 * Webhook 平台基类。
 *
 * 注意：`send()` 在本类里是**空实现** —— webhook 类平台的回复通常
 * 走「同步响应体」或「主动调用 API」，由子类决定。
 */
export abstract class WebhookPlatform implements PlatformAdapter {
  status: PlatformStatus = 'pending';
  lastError: string | null = null;

  constructor(
    protected readonly codec: WebhookCodec,
    protected readonly platformId: string,
    protected readonly platformType: string,
    protected readonly desc: string,
  ) {}

  meta(): PlatformMeta {
    return { id: this.platformId, type: this.platformType, desc: this.desc };
  }

  async start(): Promise<void> {
    this.status = 'running';
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
  }

  /** 由 HTTP 层调用：处理一次回调。 */
  async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    if (!this.codec.verify(req)) {
      this.lastError = '签名校验失败';
      return { status: 401, body: { error: 'invalid signature' } };
    }

    const decoded = this.codec.decode(req);
    if (decoded === null) {
      // 非消息事件（如 URL 验证、加入群聊）—— 正常 200，不做处理
      return { status: 200, body: { ok: true } };
    }
    return { status: 200, body: { ok: true, messageId: decoded.messageId } };
  }

  /** webhook 类平台的主动推送（部分平台支持）。 */
  async send(_event: MessageEvent, _chunk: OutgoingChunk): Promise<void> {
    // 由子类覆盖；默认不支持主动推送
  }
}

/* ---------------------------- 签名工具 ---------------------------- */

/**
 * 飞书 / 企微用的 HMAC-SHA256 签名。
 *
 * 注意：这里用 Web Crypto，不引第三方库 —— Node 22 原生支持。
 */
export async function hmacSha256Base64(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return Buffer.from(sig).toString('base64');
}

/** 飞书 SHA-256 签名（大写十六进制）。 */
export async function sha256Hex(payload: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(payload));
  return Buffer.from(digest).toString('hex');
}

/**
 * 常量时间比较，防时序攻击。
 *
 * 直接 `===` 会在第一个不同字节就返回，理论上可被用于探测签名。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
