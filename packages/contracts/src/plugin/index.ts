/**
 * 插件契约（最小可用版，静态注册）。
 *
 * 评审后的收紧（见 `docs/spec/10-review-decisions.md` §二）：
 * - 砍掉 `MemoryStore` 扩展点：任务卡是核心数据，多实现导致「哪份是真的」不可判定
 * - `RuleRetriever` 降级为**只读**：只返回候选编号，拿不到 `predicate`，无法伪造判定
 * - `ToolPack` 的工具同样只能拿到 `ApplicationService`，拿不到仓储
 *
 * 不做的事：manifest 文件发现、动态 `import()`、配置 schema、外部插件目录。
 * 理由：Node ESM 缓存不可清除，热加载风险大于收益；比赛场景无此需求。
 */

import type { RuleCode, RuleVersion } from '@harness/domain';
import type { ToolOutcome } from '../errors/index.js';

/* ------------------------------ Manifest ------------------------------ */

export type ExtensionKind =
  | 'tool-pack'
  | 'llm-provider'
  | 'rule-retriever'
  | 'reply-renderer'
  | 'importer'
  | 'trace-sink';

/** 插件声明需要宿主授予的能力。未声明就调用 → 抛错。 */
export type HostCapability = 'application:read' | 'application:write' | 'trace:emit';

export interface PluginManifest {
  /** `<scope>/<name>`，如 `builtin/invoice-tools`。 */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /** 宿主 API 版本约束（semver range）。 */
  readonly apiVersion: string;
  readonly provides: readonly ExtensionKind[];
  readonly requires?: readonly HostCapability[];
}

/* ---------------------------- 插件上下文 ---------------------------- */

export interface PluginLogger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/**
 * 插件能拿到的能力。
 *
 * **只读能力是 `ApplicationService` 的窄接口**，插件拿不到仓储、
 * 拿不到事务、拿不到数据库连接。这是边界机制的物理保证。
 */
export interface PluginContext {
  readonly manifest: PluginManifest;
  readonly logger: PluginLogger;
  /** 仅在 manifest 声明了 `application:read` 时存在。 */
  readonly reader?: unknown;
  /** 仅在 manifest 声明了 `application:write` 时存在。 */
  readonly writer?: unknown;
}

export interface PluginInstance {
  /** 注册本插件提供的扩展点。 */
  register(registry: ExtensionRegistry): void;
  /** 可选生命周期。 */
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export type PluginFactory = (ctx: PluginContext) => PluginInstance | Promise<PluginInstance>;

/** 零逻辑工厂，只为类型推断与未来扩展留钩子。 */
export function definePlugin(factory: PluginFactory): PluginFactory {
  return factory;
}

/* ------------------------------ 扩展点 ------------------------------ */

export interface ToolDefinition {
  /** snake_case，全局唯一。插件提供的工具须以 `_plugin` 结尾。 */
  readonly name: string;
  readonly description: string;
  /** zod schema。用 `unknown` 避免 contracts 依赖具体 zod 版本的泛型。 */
  readonly inputSchema: unknown;
  readonly execute: (args: unknown, ctx: ToolExecutionContext) => Promise<ToolOutcome<unknown>>;
  /** 同名冲突时高者胜。 */
  readonly priority?: number;
}

export interface ToolExecutionContext {
  readonly runId: string;
  readonly toolCallId: string;
  readonly userId: string;
  /** 本轮已通过授权检查的企业。工具**不接收**模型传来的企业号。 */
  readonly enterpriseId: string;
}

export interface ToolPackExtension {
  readonly kind: 'tool-pack';
  tools(): readonly ToolDefinition[];
}

export interface LlmProviderExtension {
  readonly kind: 'llm-provider';
  readonly providerId: string;
  createModel(config: unknown): unknown;
}

export interface RuleCandidate {
  readonly code: string;
  readonly version: string;
  readonly score: number;
  readonly matchedKeywords: readonly string[];
}

/**
 * 规则检索器：**只读**。
 *
 * 只返回候选编号，不返回 `RuleDocument`。最终用哪条规则由领域层
 * `selectApplicableRules` 决定 —— 检索器算错不会导致业务错误，只会导致解释不全。
 */
export interface RuleRetrieverExtension {
  readonly kind: 'rule-retriever';
  search(query: { readonly text: string }): Promise<readonly RuleCandidate[]>;
}

export interface DraftReply {
  readonly text: string;
  readonly provenance: ReadonlyArray<{ readonly literal: string; readonly source: string }>;
}

export interface RenderedReply {
  readonly text: string;
}

export interface ReplyRendererExtension {
  readonly kind: 'reply-renderer';
  readonly rendererId: string;
  render(draft: DraftReply): Promise<RenderedReply>;
}

export interface ImportBundle {
  readonly enterprises: readonly unknown[];
  readonly users: readonly unknown[];
  readonly invoices: readonly unknown[];
  readonly bankTransactions: readonly unknown[];
  readonly rules: readonly unknown[];
}

export interface ImporterExtension {
  readonly kind: 'importer';
  readonly formatId: string;
  canHandle(path: string): boolean;
  parse(path: string): Promise<ImportBundle>;
}

export interface TraceSinkExtension {
  readonly kind: 'trace-sink';
  write(run: unknown): Promise<void>;
  list(filter?: unknown): Promise<unknown[]>;
}

/* ---------------------------- 注册表 ---------------------------- */

export class PluginConflictError extends Error {
  constructor(
    readonly kind: ExtensionKind,
    readonly key: string,
  ) {
    super(`插件冲突：${kind} 的 "${key}" 已被注册`);
    this.name = 'PluginConflictError';
  }
}

/**
 * 扩展点注册表。
 *
 * 只在启动期写入（静态注册），运行期只读。不做热插拔。
 */
export class ExtensionRegistry {
  private readonly toolPacks: ToolPackExtension[] = [];
  private readonly providers = new Map<string, LlmProviderExtension>();
  private readonly retrievers: RuleRetrieverExtension[] = [];
  private readonly renderers = new Map<string, ReplyRendererExtension>();
  private readonly importers: ImporterExtension[] = [];
  private readonly sinks: TraceSinkExtension[] = [];

  addToolPack(pack: ToolPackExtension): void {
    const incoming = new Set(pack.tools().map((t) => t.name));
    for (const existing of this.toolPacks) {
      for (const t of existing.tools()) {
        if (incoming.has(t.name)) {
          throw new PluginConflictError('tool-pack', t.name);
        }
      }
    }
    this.toolPacks.push(pack);
  }

  addLlmProvider(p: LlmProviderExtension): void {
    if (this.providers.has(p.providerId)) {
      throw new PluginConflictError('llm-provider', p.providerId);
    }
    this.providers.set(p.providerId, p);
  }

  addRuleRetriever(r: RuleRetrieverExtension): void {
    this.retrievers.push(r);
  }

  addReplyRenderer(r: ReplyRendererExtension): void {
    if (this.renderers.has(r.rendererId)) {
      throw new PluginConflictError('reply-renderer', r.rendererId);
    }
    this.renderers.set(r.rendererId, r);
  }

  addImporter(i: ImporterExtension): void {
    this.importers.push(i);
  }

  addTraceSink(s: TraceSinkExtension): void {
    this.sinks.push(s);
  }

  tools(): readonly ToolDefinition[] {
    return this.toolPacks.flatMap((p) => p.tools());
  }

  provider(providerId: string): LlmProviderExtension | undefined {
    return this.providers.get(providerId);
  }

  retriever(): RuleRetrieverExtension | undefined {
    return this.retrievers[0];
  }

  renderer(rendererId: string): ReplyRendererExtension | undefined {
    return this.renderers.get(rendererId);
  }

  activeRenderer(): ReplyRendererExtension | undefined {
    return this.renderers.values().next().value;
  }

  importerFor(path: string): ImporterExtension | undefined {
    return this.importers.find((i) => i.canHandle(path));
  }

  allSinks(): readonly TraceSinkExtension[] {
    return this.sinks;
  }

  /** 诊断用：列出当前注册了什么。 */
  summary(): Record<ExtensionKind, readonly string[]> {
    return {
      'tool-pack': this.toolPacks.flatMap((p) => p.tools().map((t) => t.name)),
      'llm-provider': [...this.providers.keys()],
      'rule-retriever': this.retrievers.map((_, i) => `retriever#${i}`),
      'reply-renderer': [...this.renderers.keys()],
      importer: this.importers.map((i) => i.formatId),
      'trace-sink': this.sinks.map((_, i) => `sink#${i}`),
    };
  }
}

/* ---------------------------- 加载器 ---------------------------- */

export interface PluginLoadFailure {
  readonly pluginId: string;
  readonly stage: 'instantiate' | 'register' | 'start';
  readonly message: string;
}

export interface LoadSummary {
  readonly loaded: readonly string[];
  readonly failed: readonly PluginLoadFailure[];
}

/**
 * 插件宿主：**失败隔离**。
 *
 * 单个插件失败不中断整批加载，失败原因记录在 `failed` 里，
 * 由 `plugin list` 展示。演示时不能因为一个插件挂了整个系统起不来。
 */
export class PluginHost {
  private readonly registry = new ExtensionRegistry();
  private readonly loaded = new Set<string>();
  private readonly failures = new Map<string, PluginLoadFailure>();

  constructor(
    private readonly manifests: ReadonlyArray<{
      readonly manifest: PluginManifest;
      readonly factory: PluginFactory;
    }>,
    private readonly baseContext: Omit<PluginContext, 'manifest'>,
  ) {}

  async loadAll(): Promise<LoadSummary> {
    for (const { manifest, factory } of this.manifests) {
      try {
        const instance = await factory({ ...this.baseContext, manifest });
        instance.register(this.registry);
        await instance.start?.();
        this.loaded.add(manifest.id);
      } catch (err) {
        this.failures.set(manifest.id, {
          pluginId: manifest.id,
          stage: 'register',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { loaded: [...this.loaded], failed: [...this.failures.values()] };
  }

  get extensions(): ExtensionRegistry {
    return this.registry;
  }

  get failedPlugins(): readonly PluginLoadFailure[] {
    return [...this.failures.values()];
  }
}

export type { RuleCode, RuleVersion };
