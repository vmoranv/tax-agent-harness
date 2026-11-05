import type { Brand } from '../shared/brand.js';
import { InvalidTextError } from '../shared/domain-error.js';
import type { EnterpriseId } from '../shared/ids.js';
import type { IsoDate } from '../shared/month.js';

/** 企业法定名称：NFKC + trim，1..100。 */
export type EnterpriseName = Brand<string, 'EnterpriseName'>;

const MAX_NAME = 100;

function normalizeName(raw: string): string {
  const s = raw.normalize('NFKC').trim();
  if (s.length === 0) {
    throw new InvalidTextError('企业名称不能为空');
  }
  if (s.length > MAX_NAME) {
    throw new InvalidTextError(`企业名称不能超过 ${MAX_NAME} 个字符`, { length: s.length });
  }
  return s;
}

export function enterpriseName(raw: string): EnterpriseName {
  return normalizeName(raw) as EnterpriseName;
}

export interface EnterpriseSnapshot {
  readonly id: EnterpriseId;
  readonly legalName: EnterpriseName;
  readonly aliases: readonly string[];
  readonly status: 'active' | 'inactive';
  readonly version: number;
}

/**
 * 企业聚合根。
 *
 * 别名用于把自然语言里的称呼（「甲企业」「甲公司」）映射到唯一标识；
 * 匹配在归一化 + 大小写折叠后的文本上做，避免全角/半角与首尾空白造成漏配。
 * 别名全局唯一由仓储的 `findByAlias` 保证，领域层只保证本地不重复。
 */
export class Enterprise {
  private constructor(
    readonly id: EnterpriseId,
    private readonly legalNameValue: string,
    private readonly aliases: Set<string>,
    private statusValue: 'active' | 'inactive',
    private versionValue: number,
  ) {}

  static register(
    id: EnterpriseId,
    legalName: EnterpriseName,
    aliases: readonly string[] = [],
  ): Enterprise {
    const set = new Set<string>();
    for (const a of aliases) set.add(normalizeName(a));
    return new Enterprise(id, normalizeName(legalName), set, 'active', 0);
  }

  static rehydrate(snapshot: EnterpriseSnapshot): Enterprise {
    return new Enterprise(
      snapshot.id,
      snapshot.legalName,
      new Set(snapshot.aliases),
      snapshot.status,
      snapshot.version,
    );
  }

  get legalName(): EnterpriseName {
    return this.legalNameValue as EnterpriseName;
  }

  get version(): number {
    return this.versionValue;
  }

  get status(): 'active' | 'inactive' {
    return this.statusValue;
  }

  /** 匹配 id / 法定名 / 别名；NFKC + trim + 大小写折叠。 */
  matchesName(raw: string): boolean {
    const probe = raw.normalize('NFKC').trim().toLowerCase();
    if (probe.length === 0) return false;
    if (probe === this.id.toLowerCase()) return true;
    if (probe === this.legalNameValue.toLowerCase()) return true;
    for (const alias of this.aliases) {
      if (alias.toLowerCase() === probe) return true;
    }
    return false;
  }

  addAlias(raw: string, _at: IsoDate): void {
    const alias = normalizeName(raw);
    if (alias === this.legalNameValue || this.aliases.has(alias)) return;
    this.aliases.add(alias);
    this.versionValue += 1;
  }

  aliasesFor(): readonly string[] {
    return [...this.aliases];
  }

  /** 企业不可删除，只能停用。 */
  deactivate(): void {
    if (this.statusValue === 'inactive') return;
    this.statusValue = 'inactive';
    this.versionValue += 1;
  }

  toSnapshot(): EnterpriseSnapshot {
    return {
      id: this.id,
      legalName: this.legalNameValue as EnterpriseName,
      aliases: [...this.aliases],
      status: this.statusValue,
      version: this.versionValue,
    };
  }
}
