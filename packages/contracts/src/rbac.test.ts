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
});
