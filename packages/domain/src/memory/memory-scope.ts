import type { Brand } from '../shared/brand.js';
import { InvalidGrantError } from '../shared/domain-error.js';
import type { EnterpriseId, InvoiceId, InvoiceNo, UserId } from '../shared/ids.js';

/**
 * 记忆作用域：`(userId, enterpriseId)`。
 *
 * 记忆与任务卡**永不允许**跨 scope 读取。仓储层拿到不属于当前
 * 用户的 scope 时必须返回空，而不是「过滤后返回空」—— 前者不泄漏
 * 「存在但不属于你」，后者会让调用方误以为查过了。
 */
export interface MemoryScopeShape {
  readonly userId: UserId;
  readonly enterpriseId: EnterpriseId;
}

export type MemoryScope = Brand<MemoryScopeShape, 'MemoryScope'>;

export function memoryScope(user: UserId, enterprise: EnterpriseId): MemoryScope {
  if (typeof user !== 'string' || typeof enterprise !== 'string') {
    throw new InvalidGrantError('记忆作用域的用户与企业必须同时存在', { user, enterprise });
  }
  return Object.freeze({ userId: user, enterpriseId: enterprise }) as MemoryScope;
}

/** 仓储分区键，形如 `U001|C001`。 */
export function scopeKey(s: MemoryScope): string {
  return `${s.userId}|${s.enterpriseId}`;
}

/** 判断两个 scope 是否同一用户同一企业（而非同一用户跨企业）。 */
export function sameScope(a: MemoryScope, b: MemoryScope): boolean {
  return a.userId === b.userId && a.enterpriseId === b.enterpriseId;
}

/** 发票引用：任务卡只存这个，绝不存金额/销售方/用途文本。 */
export interface InvoiceRefShape {
  readonly enterpriseId: EnterpriseId;
  readonly invoiceNo: InvoiceNo;
}

export type InvoiceRef = Brand<InvoiceRefShape, 'InvoiceRef'>;

/** 唯一转换入口：从 InvoiceId 拆出企业+编号。 */
export function invoiceRefOf(id: InvoiceId): InvoiceRef {
  return invoiceRef(id);
}

export function invoiceRef(id: InvoiceId): InvoiceRef {
  return Object.freeze({
    enterpriseId: id.enterpriseId,
    invoiceNo: id.invoiceNo,
  }) as InvoiceRef;
}

/** 从企业号 + 发票号直接构造（调用方已分别持有二者时）。 */
export function invoiceRefParts(enterpriseId: EnterpriseId, invoiceNo: InvoiceNo): InvoiceRef {
  return Object.freeze({ enterpriseId, invoiceNo }) as InvoiceRef;
}

/** 引用的稳定字符串键，用于集合去重：`C001/F002`。 */
export function refKey(ref: InvoiceRef): string {
  return `${ref.enterpriseId}/${ref.invoiceNo}`;
}
