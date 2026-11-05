import { describe, expect, it } from 'vitest';
import type { AccessGrant } from '../src/index.js';
import {
  AccessLevel,
  accessGrant,
  decideRead,
  decideWrite,
  enterpriseId,
  isMutableField,
  parseIsoDate,
  UserAccount,
  userId,
} from '../src/index.js';

const AT = parseIsoDate('2026-09-01');
const U001 = userId('U001');
const U002 = userId('U002');
const C001 = enterpriseId('C001');
const C002 = enterpriseId('C002');

/** U001: C001=read-write, C002=none；U002: C001=read-only */
function accounts(): { u001: UserAccount; u002: UserAccount } {
  const u001 = UserAccount.register(U001, '张主管', AT);
  u001.grant(C001, 'read-write', 'system', AT);
  u001.grant(C002, 'none', 'system', AT);

  const u002 = UserAccount.register(U002, '李会计', AT);
  u002.grant(C001, 'read-only', 'system', AT);
  return { u001, u002 };
}

describe('授权三态', () => {
  it('AccessLevel 取值就是三态', () => {
    expect(AccessLevel.None).toBe('none');
    expect(AccessLevel.ReadOnly).toBe('read-only');
    expect(AccessLevel.ReadWrite).toBe('read-write');
  });

  it('同一企业重复授权就地更新等级，不产生第二条记录', () => {
    const { u001 } = accounts();
    u001.grant(C001, 'read-only', 'system', AT);
    expect(u001.grantsFor()).toHaveLength(2);
    expect(u001.levelFor(C001)).toBe('read-only');
  });

  it('停用账号后 levelFor 恒为 none，grantFor 返回 null', () => {
    const { u001 } = accounts();
    u001.disable(AT);
    expect(u001.levelFor(C001)).toBe('none');
    expect(u001.grantFor(C001)).toBeNull();
    expect(u001.isActive()).toBe(false);
  });
});

describe('decideRead', () => {
  it('U001/C001 有 read-write 授权 → 允许读', () => {
    const { u001 } = accounts();
    const d = decideRead(u001.grantFor(C001));
    expect(d.allowed).toBe(true);
  });

  it('U001/C002 明确 none → 拒绝且原因为 enterprise_not_accessible', () => {
    const { u001 } = accounts();
    const d = decideRead(u001.grantFor(C002));
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('enterprise_not_accessible');
  });

  it('U002/C001 read-only → 允许读', () => {
    const { u002 } = accounts();
    expect(decideRead(u002.grantFor(C001)).allowed).toBe(true);
  });

  it('U002/C002 无授权记录 → 拒绝且原因为 no_grant', () => {
    const { u002 } = accounts();
    const d = decideRead(u002.grantFor(C002));
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('no_grant');
  });

  it('null 授权（无记录）先于任何存在性检查 → no_grant', () => {
    const d = decideRead(null);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('no_grant');
  });

  it('企业不存在与无权访问返回同一种拒绝，不泄漏存在性', () => {
    const { u002 } = accounts();
    const missingEnterprise = decideRead(u002.grantFor(enterpriseId('C999')));
    const forbidden = decideRead(
      accessGrant({
        enterpriseId: enterpriseId('C999'),
        level: 'none',
        grantedAt: AT,
        grantedBy: 'system',
      }),
    );
    expect(missingEnterprise).toEqual({
      allowed: false,
      reason: 'no_grant',
      message: '没有该企业的授权记录',
    });
    expect(forbidden.allowed).toBe(false);
    if (!forbidden.allowed) expect(forbidden.reason).toBe('enterprise_not_accessible');
  });
});

describe('decideWrite', () => {
  it('U001/C001 read-write 改 purpose → 允许，且决策带上企业与字段', () => {
    const { u001 } = accounts();
    const d = decideWrite(u001.grantFor(C001), 'purpose');
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.enterpriseId).toBe(C001);
      expect(d.field).toBe('purpose');
    }
  });

  it('U002/C001 read-only → 拒绝，原因为 read_only_enterprise', () => {
    const { u002 } = accounts();
    const d = decideWrite(u002.grantFor(C001), 'purpose');
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('read_only_enterprise');
  });

  it('U001/C002 none → 拒绝，原因为 enterprise_not_accessible', () => {
    const { u001 } = accounts();
    const d = decideWrite(u001.grantFor(C002), 'purpose');
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('enterprise_not_accessible');
  });

  it('无授权记录 → no_grant，先于字段白名单', () => {
    const d = decideWrite(null, 'amount' as never);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('no_grant');
  });

  it('字段不在白名单 → field_not_mutable', () => {
    const { u001 } = accounts();
    for (const field of ['amount', 'invoiceNo', 'sellerName', 'issuedOn']) {
      const d = decideWrite(u001.grantFor(C001), field as never);
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toBe('field_not_mutable');
    }
  });

  it('判定顺序：read-only 先于 field_not_mutable', () => {
    const { u002 } = accounts();
    const d = decideWrite(u002.grantFor(C001), 'amount' as never);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('read_only_enterprise');
  });

  it('isMutableField 只认 purpose / remark', () => {
    expect(isMutableField('purpose')).toBe(true);
    expect(isMutableField('remark')).toBe(true);
    expect(isMutableField('amount')).toBe(false);
    expect(isMutableField(null)).toBe(false);
    expect(isMutableField(42)).toBe(false);
  });
});

describe('AccessGrant 值对象', () => {
  it('未知等级被拒绝', () => {
    expect(() =>
      accessGrant({
        enterpriseId: C001,
        level: 'admin' as never,
        grantedAt: AT,
        grantedBy: 'system',
      }),
    ).toThrow();
  });

  it('冻结后不可改', () => {
    const g: AccessGrant = accessGrant({
      enterpriseId: C001,
      level: 'read-only',
      grantedAt: AT,
      grantedBy: 'system',
    });
    expect(Object.isFrozen(g)).toBe(true);
  });
});
