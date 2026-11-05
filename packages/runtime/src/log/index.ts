/**
 * 日志系统（
 *
 * 三个关键机制：
 * 1. **LogContext** —— 用 AsyncLocalStorage 把「当前会话/用户/企业」绑到日志上，
 *    这样一行日志就能看出它属于哪个 run，不用手动传参。
 * 2. **LogBroker** —— 环形缓存 + 多订阅者广播。Web 的 SSE 日志面板是订阅者之一，
 *    新连上的客户端能先收到最近 N 条，不会看到空白。
 * 3. **结构化输出** —— 每条日志是对象（level/time/msg/context），不是拼接字符串。
 *
 * 与 Harness 的差异：
 * - Harness 用 Python `contextvars`，TS 用 `AsyncLocalStorage`
 * - Harness 的 broker 要处理跨事件循环（`call_soon_threadsafe`），
 *   Node 是单线程，简化为同步广播
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 绑到当前异步执行链上的上下文。 */
export interface LogContext {
  readonly runId?: string;
  readonly sessionId?: string;
  readonly userId?: string;
  readonly enterpriseId?: string;
  /** 自定义字段，如 `{ tool: 'summarize_enterprise_month' }`。 */
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface LogEntry {
  readonly level: LogLevel;
  readonly time: string;
  readonly msg: string;
  readonly context: LogContext;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly error?: { readonly name: string; readonly message: string; readonly stack?: string };
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const storage = new AsyncLocalStorage<LogContext>();

/** 在给定上下文里执行，期间发出的所有日志都会带上它。 */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** 在已有上下文上叠加字段（不覆盖外层）。 */
export function withLogFields<T>(fields: Record<string, unknown>, fn: () => T): T {
  const cur = storage.getStore() ?? {};
  return storage.run({ ...cur, fields: { ...cur.fields, ...fields } }, fn);
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}

/* ---------------------------- 脱敏 ---------------------------- */

/** 落盘前必须过的红线：不让密钥进日志。 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /(?:api[_-]?key|authorization|token)\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}/gi,
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[REDACTED]');
  return out;
}

function redactUnknown(v: unknown): unknown {
  if (typeof v === 'string') return redactSecrets(v);
  if (v instanceof Error)
    return { name: v.name, message: redactSecrets(v.message), stack: v.stack };
  if (Array.isArray(v)) return v.map(redactUnknown);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = redactUnknown(val);
    return out;
  }
  return v;
}

/* ---------------------------- Broker ---------------------------- */

export type LogSink = (entry: LogEntry) => void;

export interface LogBrokerOptions {
  /** 环形缓存容量：新订阅者会先收到最近的 N 条。 */
  readonly cacheSize?: number;
  /** 最低输出级别。 */
  readonly minLevel?: LogLevel;
}

/**
 * 日志代理：环形缓存 + 多订阅者。
 *
 * 与 Harness `LogBroker` 同构：`register()` 返回取消函数，
 * 订阅者收到的是同一个不可变 entry 对象。
 */
export class LogBroker {
  private readonly cache: LogEntry[] = [];
  private readonly sinks = new Set<LogSink>();
  private readonly cacheSize: number;
  private readonly minLevel: LogLevel;

  constructor(opts: LogBrokerOptions = {}) {
    this.cacheSize = opts.cacheSize ?? 500;
    this.minLevel = opts.minLevel ?? 'info';
  }

  /** 订阅；立即回放缓存后再接收新的。返回取消订阅函数。 */
  subscribe(sink: LogSink, opts: { replay?: boolean } = {}): () => void {
    if (opts.replay !== false) {
      for (const e of this.cache) sink(e);
    }
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  /** 最近 N 条（供 Web 面板首次加载）。 */
  recent(limit = 100): readonly LogEntry[] {
    return this.cache.slice(-limit);
  }

  emit(level: LogLevel, msg: string, fields?: Record<string, unknown>, err?: unknown): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;

    const entry: LogEntry = {
      level,
      time: new Date().toISOString(),
      msg: redactSecrets(msg),
      context: currentLogContext(),
      ...(fields === undefined ? {} : { fields: redactUnknown(fields) as Record<string, unknown> }),
      ...(err === undefined
        ? {}
        : {
            error: {
              name: err instanceof Error ? err.name : 'Error',
              message: redactSecrets(err instanceof Error ? err.message : String(err)),
              ...(err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
            },
          }),
    };

    this.cache.push(entry);
    if (this.cache.length > this.cacheSize) this.cache.shift();

    for (const sink of this.sinks) {
      try {
        sink(entry);
      } catch {
        // 订阅者异常不能影响业务日志
      }
    }
  }

  /** 控制台输出（默认 sink）。 */
  consoleSink(): LogSink {
    return (e) => {
      const tag = e.context.runId === undefined ? '' : ` [${e.context.runId}]`;
      const f = e.fields === undefined ? '' : ` ${JSON.stringify(e.fields)}`;
      const line = `${e.time} ${e.level.toUpperCase()}${tag} ${e.msg}${f}`;
      if (e.level === 'error') console.error(line, e.error ?? '');
      else if (e.level === 'warn') console.warn(line);
      else console.log(line);
    };
  }
}

/** 全局 broker（可被 CLI / Web 共用）。 */
export const logBroker = new LogBroker({ minLevel: 'info' });

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>): void =>
    logBroker.emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>): void =>
    logBroker.emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>): void =>
    logBroker.emit('warn', msg, fields),
  error: (msg: string, err?: unknown, fields?: Record<string, unknown>): void =>
    logBroker.emit('error', msg, fields, err),
};
