/**
 * Telegram 平台适配器（长轮询）。
 *
 * Bot API 要点：
 * - 拉取：`GET /bot<token>/getUpdates?offset=<last+1>&timeout=<sec>`
 * - 更新结构：`{ update_id, message: { message_id, text, chat: { id }, from: { id } } }`
 * - 回复：`POST /bot<token>/sendMessage`，`{ chat_id, text }`
 *
 * 身份映射：Telegram 账号 ≠ 财税用户，用显式绑定表 `chatBindings`：
 * chatId → { userId, enterpriseId }。未绑定的会话回复「未绑定」提示，
 * 不猜身份 —— 权限边界从平台入口就开始守。
 *
 * 与 webhook 类平台（飞书/钉钉/企微/QQ）不同：长轮询**不需要公网回调
 * 地址与验签**（token 即凭证），因此是 A 档里唯一能用假 fetch 完整自测的。
 */

import {
  type IncomingMessage,
  MessageEvent,
  type OutgoingChunk,
  type PlatformAdapter,
  type PlatformMeta,
  type PlatformStatus,
  Umo,
} from '../index.js';

export interface TelegramBinding {
  readonly userId: string;
  readonly enterpriseId: string;
  readonly enterpriseName?: string;
}

export interface TelegramConfig {
  readonly botToken: string;
  /** chatId（字符串）→ 财税身份。未命中的 chat 不处理。 */
  readonly chatBindings: Readonly<Record<string, TelegramBinding>>;
  readonly pollTimeoutSec?: number;
  /** 注入 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch;
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly message_id: number;
    readonly text?: string;
    readonly chat?: { readonly id: number | string };
    readonly from?: { readonly id: number | string; readonly username?: string };
  };
}

type FetchLike = (
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

export class TelegramPlatform implements PlatformAdapter {
  status: PlatformStatus = 'pending';
  lastError: string | null = null;

  private readonly fetchImpl: FetchLike;
  private offset = 0;
  private stopRequested = false;
  private onMessage: ((event: MessageEvent) => Promise<void>) | null = null;

  constructor(
    private readonly config: TelegramConfig,
    private readonly platformId = 'telegram',
  ) {
    this.fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  meta(): PlatformMeta {
    return { id: this.platformId, type: 'telegram', desc: 'Telegram 机器人（长轮询）' };
  }

  async start(onMessage: (event: MessageEvent) => Promise<void>): Promise<void> {
    this.onMessage = onMessage;
    this.stopRequested = false;
    this.status = 'running';
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.status = 'stopped';
  }

  /**
   * 长轮询循环。timeout=0（不挂起）以便 stop 能及时生效；
   * 生产可调大 pollTimeoutSec 减少空转。
   */
  private async pollLoop(): Promise<void> {
    while (!this.stopRequested) {
      try {
        const updates = await this.getUpdates();
        for (const u of updates) {
          this.offset = u.update_id + 1;
          const msg = this.decode(u);
          if (msg !== null && this.onMessage !== null) {
            const chatId = String(u.message?.chat?.id ?? '');
            await this.onMessage(this.toEvent(msg, chatId));
          }
        }
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.status = 'error';
        // 指数退避由外层 setTimeout 简化为固定 3s（比赛场景足够）
        await sleep(3_000);
        this.status = 'running';
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const url =
      `${this.apiBase()}/getUpdates?offset=${this.offset}` +
      `&timeout=${this.config.pollTimeoutSec ?? 0}&allowed_updates=${encodeURIComponent('["message"]')}`;
    const res = await this.fetchImpl(url, { method: 'GET' });
    const body = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
    if (body.ok !== true) {
      throw new Error(`Telegram getUpdates 失败：${JSON.stringify(body).slice(0, 200)}`);
    }
    return body.result ?? [];
  }

  private decode(u: TelegramUpdate): IncomingMessage | null {
    const text = (u.message?.text ?? '').trim();
    const chatId = u.message?.chat?.id;
    if (text === '' || chatId === undefined) return null;

    const binding = this.config.chatBindings[String(chatId)];
    if (binding === undefined) return null; // 未绑定的会话静默忽略，不猜身份

    return {
      userId: binding.userId as never,
      enterpriseId: binding.enterpriseId as never,
      text,
      messageId: String(u.message?.message_id ?? u.update_id),
      receivedAt: new Date().toISOString(),
    };
  }

  /** 解码结果 → 完整事件（携带 Umo 与回推所需的 chatId）。 */
  private toEvent(msg: IncomingMessage, chatId: string): MessageEvent {
    const event = new MessageEvent(Umo.of(this.platformId, 'telegram', chatId), msg);
    event.setExtra('telegram', { chatId });
    return event;
  }

  async send(event: MessageEvent, chunk: OutgoingChunk): Promise<void> {
    const text =
      chunk.kind === 'done' ? chunk.text : chunk.kind === 'error' ? `[错误] ${chunk.message}` : '';
    if (text === '') return;

    const chatId = event.getExtra<Record<string, string>>('telegram')?.chatId ?? '';
    if (chatId === '') return; // 非 Telegram 来源的事件不回推

    await this.fetchImpl(`${this.apiBase()}/sendMessage`, {
      method: 'POST',
      body: JSON.stringify({ chat_id: chatId, text }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private apiBase(): string {
    return `https://api.telegram.org/bot${this.config.botToken}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type { IncomingMessage };
