import { describe, expect, it } from 'vitest';
import { can } from './rbac.js';

// Mirrors the control-plane authority matrix for the UI-relevant operations. These
// expectations must track services/control-plane/src/domain/rbac.ts.
describe('can — client RBAC mirror (display-only)', () => {
  it('tenant_admin owns everything within its tenant', () => {
    expect(can('tenant_admin', 'alert:create')).toBe(true);
    expect(can('tenant_admin', 'apikey:create')).toBe(true);
    expect(can('tenant_admin', 'apikey:revoke')).toBe(true);
    expect(can('tenant_admin', 'user:create')).toBe(true);
    expect(can('tenant_admin', 'retention:update')).toBe(true);
    expect(can('tenant_admin', 'tenant:read')).toBe(true);
  });

  it('tenant_admin may NOT update the tenant registry (platform_operator-only)', () => {
    expect(can('tenant_admin', 'tenant:update')).toBe(false);
  });

  it('member is read-mostly: reads alerts + retention, no config writes', () => {
    expect(can('member', 'alert:read')).toBe(true);
    expect(can('member', 'alert:list')).toBe(true);
    expect(can('member', 'retention:read')).toBe(true);
    expect(can('member', 'tenant:read')).toBe(true);

    expect(can('member', 'alert:create')).toBe(false);
    expect(can('member', 'retention:update')).toBe(false);
    expect(can('member', 'user:list')).toBe(false);
    expect(can('member', 'apikey:list')).toBe(false);
  });

  it('platform_operator is not granted tenant-owned operations (NFR-5.4)', () => {
    expect(can('platform_operator', 'apikey:list')).toBe(false);
    expect(can('platform_operator', 'user:list')).toBe(false);
    expect(can('platform_operator', 'retention:read')).toBe(false);
  });

  it('tenant_admin is granted all invite operations (R-INV-7, R-INV-8)', () => {
    expect(can('tenant_admin', 'invite:create')).toBe(true);
    expect(can('tenant_admin', 'invite:list')).toBe(true);
    expect(can('tenant_admin', 'invite:revoke')).toBe(true);
  });

  it('member is denied all invite operations', () => {
    expect(can('member', 'invite:create')).toBe(false);
    expect(can('member', 'invite:list')).toBe(false);
    expect(can('member', 'invite:revoke')).toBe(false);
  });

  it('platform_operator is denied all invite operations', () => {
    expect(can('platform_operator', 'invite:create')).toBe(false);
    expect(can('platform_operator', 'invite:list')).toBe(false);
    expect(can('platform_operator', 'invite:revoke')).toBe(false);
  });

  it('member may read/list dashboards but not write them', () => {
    expect(can('member', 'dashboard:list')).toBe(true);
    expect(can('member', 'dashboard:read')).toBe(true);
    expect(can('member', 'dashboard:create')).toBe(false);
    expect(can('member', 'dashboard:update')).toBe(false);
    expect(can('member', 'dashboard:delete')).toBe(false);
  });

  it('tenant_admin owns all dashboard operations', () => {
    expect(can('tenant_admin', 'dashboard:create')).toBe(true);
    expect(can('tenant_admin', 'dashboard:read')).toBe(true);
    expect(can('tenant_admin', 'dashboard:list')).toBe(true);
    expect(can('tenant_admin', 'dashboard:update')).toBe(true);
    expect(can('tenant_admin', 'dashboard:delete')).toBe(true);
  });

  it('platform_operator is denied all dashboard operations', () => {
    expect(can('platform_operator', 'dashboard:create')).toBe(false);
    expect(can('platform_operator', 'dashboard:read')).toBe(false);
    expect(can('platform_operator', 'dashboard:list')).toBe(false);
    expect(can('platform_operator', 'dashboard:update')).toBe(false);
    expect(can('platform_operator', 'dashboard:delete')).toBe(false);
  });

  it('unknown role fails closed', () => {
    // @ts-expect-error — intentionally exercising the runtime fail-closed path
    expect(can('nonexistent_role', 'dashboard:list')).toBe(false);
  });
});
