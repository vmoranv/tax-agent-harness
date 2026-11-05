import type { EnterpriseId, Month, UserId } from '@harness/domain';

/** 所有用例的公共身份参数。 */
export interface ActorContext {
  readonly actor: UserId;
  readonly enterpriseId: EnterpriseId;
}

export interface MonthScope extends ActorContext {
  readonly month: Month;
}

/** 单张发票定位：企业 + 发票号复合键。 */
export interface InvoiceLocator extends ActorContext {
  readonly invoiceNo: string;
}
