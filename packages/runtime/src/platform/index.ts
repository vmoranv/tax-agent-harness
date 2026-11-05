/**
 * 平台适配（
 *
 * 移植的核心概念是 **UMO（Unified Message Origin）**：
 * 把「哪个平台的哪个会话」压成一个字符串
 * `platform_id:type:session_id`，这样上层只认 UMO，不关心底层是 CLI、
 * HTTP、还是钉钉/企微/飞书。
 *
 * 为什么要这个抽象：赛题只要求「命令行或其他简单入口」，但演示要多入口
 * （CLI + Web），而且真实财税场景一定有 IM。把 UMO 做对，接一个 IM
 * 只需要实现 `PlatformAdapter` 三个方法，不用碰业务。
 *
 * 与 Harness 的差异：
 * - Harness 有 17 种平台源（QQ/微信/Telegram/Discord…），我们提供 2 个内置
 *   （CLI、HTTP）和 1 个通用的 Webhook 适配器骨架
 * - 砍掉 `PlatformStatus` 的完整状态机，只保留 `status` 与 `lastError`
 */

import type { EnterpriseId, UserId } from '@harness/domain';

/* ---------------------------- UMO ---------------------------- */

/**
 * 统一消息来源。
 *
 * 格式：`<platformId>:<platformType>:<sessionId>`
 * 例：`cli:local:u001-c001`、`web:http:abc123`、`dingtalk:webhook:staff_9527`
 */
export class Umo {
  private constructor(
    readonly platformId: string,
    readonly platformType: string,
    readonly sessionId: string,
  ) {}

  static of(platformId: string, platformType: string, sessionId: string): Umo {
    if (platformId === '' || platformType === '' || sessionId === '') {
      throw new Error('UMO 的三个部分都不能为空');
    }
    return new Umo(platformId, platformType, sessionId);
  }

  static parse(raw: string): Umo {
    const parts = raw.split(':');
    if (parts.length < 3) throw new Error(`UMO 格式非法：${raw}`);
    const [platformId, platformType, ...rest] = parts as [string, string, ...string[]];
    return new Umo(platformId, platformType, rest.join(':'));
  }

  toString(): string {
    return `${this.platformId}:${this.platformType}:${this.sessionId}`;
  }
}

/* -------------------------- 消息事件 -------------------------- */

export type MessageRole = 'user' | 'assistant';

export interface IncomingMessage {
  /** 已解析的用户与企业。IM 场景由平台侧完成身份映射。 */
  readonly userId: UserId;
  readonly enterpriseId: EnterpriseId;
  readonly text: string;
  /** 平台侧的原始消息 id，用于去重与回执。 */
  readonly messageId: string;
  readonly receivedAt: string;
}

export type OutgoingChunk =
  | { readonly kind: 'delta'; readonly text: string }
  | { readonly kind: 'tool'; readonly name: string; readonly ok: boolean }
  | { readonly kind: 'done'; readonly text: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * 消息事件：一次请求的载体。
 *
 * 与 Harness `AstrMessageEvent` 同构的关键点是
 * **`extra` 袋 + `stopped` 标志**：
 * - `extra` 让中间层往下游塞数据（如「本轮选中的规则」），不用改事件类型
 * - `stopped` 让任一环节可以短路，后续 Stage 不再执行
 */
export class MessageEvent {
  readonly umo: Umo;
  private readonly extraStore = new Map<string, unknown>();
  stopped = false;
  stopReason: string | null = null;

  constructor(
    umo: Umo,
    readonly message: IncomingMessage,
  ) {
    this.umo = umo;
  }

  get text(): string {
    return this.message.text;
  }

  get userId(): UserId {
    return this.message.userId;
  }

  get enterpriseId(): EnterpriseId {
    return this.message.enterpriseId;
  }

  setExtra(key: string, value: unknown): void {
    this.extraStore.set(key, value);
  }

  getExtra<T>(key: string, fallback?: T): T | undefined {
    const v = this.extraStore.get(key);
    return v === undefined ? fallback : (v as T);
  }

  stop(reason = 'stopped'): void {
    this.stopped = true;
    this.stopReason = reason;
  }
}

/* -------------------------- 平台适配器 -------------------------- */

export type PlatformStatus = 'pending' | 'running' | 'error' | 'stopped';

export interface PlatformMeta {
  readonly id: string;
  readonly type: string;
  readonly desc: string;
}

/**
 * 平台适配器接口。
 *
 * 实现一个 IM 接入只需三个方法：
 * - `meta()`     告诉宿主我是谁
 * - `start()`    建立长连接 / 注册 webhook
 * - `send()`     把增量回复推回去
 *
 * **不要把业务逻辑写进适配器** —— 它只负责搬运。权限、规则、金额都在用例层。
 */
export interface PlatformAdapter {
  meta(): PlatformMeta;
  readonly status: PlatformStatus;
  readonly lastError: string | null;
  start(onMessage: (event: MessageEvent) => Promise<void>): Promise<void>;
  send(event: MessageEvent, chunk: OutgoingChunk): Promise<void>;
  stop(): Promise<void>;
}

/* ---------------------------- 内置实现 ---------------------------- */

/** CLI 适配器：把终端输入变成事件，把回复打印到终端。 */
export class CliPlatform implements PlatformAdapter {
  status: PlatformStatus = 'pending';
  lastError: string | null = null;

  constructor(
    private readonly platformId = 'cli',
    private readonly out: (s: string) => void = (s) => process.stdout.write(s),
  ) {}

  meta(): PlatformMeta {
    return { id: this.platformId, type: 'cli', desc: '本地命令行' };
  }

  async start(): Promise<void> {
    this.status = 'running';
  }

  async send(_event: MessageEvent, chunk: OutgoingChunk): Promise<void> {
    switch (chunk.kind) {
      case 'delta':
        this.out(chunk.text);
        break;
      case 'tool':
        this.out(`\n  · 调用 ${chunk.name} ${chunk.ok ? '✓' : '✗'}\n`);
        break;
      case 'done':
        this.out(`\n${chunk.text}\n`);
        break;
      case 'error':
        this.out(`\n[错误] ${chunk.message}\n`);
        break;
    }
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
  }
}

/** 记录所有外发消息，供测试断言。 */
export class CapturingPlatform implements PlatformAdapter {
  status: PlatformStatus = 'pending';
  lastError: string | null = null;
  readonly sent: OutgoingChunk[] = [];

  meta(): PlatformMeta {
    return { id: 'capture', type: 'test', desc: '测试用捕获平台' };
  }

  async start(): Promise<void> {
    this.status = 'running';
  }

  async send(_event: MessageEvent, chunk: OutgoingChunk): Promise<void> {
    this.sent.push(chunk);
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
  }
}

/* ------------------------- 平台管理器 ------------------------- */

export class PlatformManager {
  private readonly adapters = new Map<string, PlatformAdapter>();

  register(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.meta().id, adapter);
  }

  get(id: string): PlatformAdapter {
    const a = this.adapters.get(id);
    if (a === undefined) throw new Error(`平台未注册：${id}`);
    return a;
  }

  list(): readonly PlatformMeta[] {
    return [...this.adapters.values()].map((a) => a.meta());
  }

  /** 按 UMO 找适配器（按 platformId 匹配）。 */
  forUmo(umo: Umo): PlatformAdapter {
    return this.get(umo.platformId);
  }
}
