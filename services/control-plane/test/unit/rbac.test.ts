import { describe, expect, it } from 'vitest';
import { can, OPERATIONS } from '../../src/domain/rbac';
import { ROLES } from '../../src/domain/roles';

// The RBAC matrix is load-bearing (issue #11 AC: a member cannot manage keys/
// users; tenant_admin can within its tenant; platform_operator manages the
// registry only). These tests pin the full matrix so a regression is caught.
describe('rbac matrix', () => {
  it('grants platform_operator the registry + admin provisioning, NOT tenant content', () => {
    expect(can('platform_operator', 'tenant:create')).toBe(true);
    expect(can('platform_operator', 'tenant:list')).toBe(true);
    expect(can('platform_operator', 'tenant:delete')).toBe(true);
    expect(can('platform_operator', 'tenant:provision_admin')).toBe(true);
    // Barred from tenant-owned resources (NFR-5.4 spirit: no tenant content).
    expect(can('platform_operator', 'user:list')).toBe(false);
    expect(can('platform_operator', 'apikey:create')).toBe(false);
    expect(can('platform_operator', 'apikey:list')).toBe(false);
    expect(can('platform_operator', 'retention:update')).toBe(false);
  });

  it('grants tenant_admin full control of its own tenant but not the registry', () => {
    expect(can('tenant_admin', 'user:create')).toBe(true);
    expect(can('tenant_admin', 'user:delete')).toBe(true);
    expect(can('tenant_admin', 'apikey:create')).toBe(true);
    expect(can('tenant_admin', 'apikey:revoke')).toBe(true);
    expect(can('tenant_admin', 'retention:update')).toBe(true);
    expect(can('tenant_admin', 'tenant:read')).toBe(true);
    expect(can('tenant_admin', 'tenant:create')).toBe(false);
    expect(can('tenant_admin', 'tenant:delete')).toBe(false);
    expect(can('tenant_admin', 'tenant:provision_admin')).toBe(false);
  });

  it('restricts member to read-only within its tenant (no key/user management)', () => {
    expect(can('member', 'retention:read')).toBe(true);
    expect(can('member', 'tenant:read')).toBe(true);
    expect(can('member', 'user:create')).toBe(false);
    expect(can('member', 'user:list')).toBe(false);
    expect(can('member', 'apikey:create')).toBe(false);
    expect(can('member', 'apikey:list')).toBe(false);
    expect(can('member', 'retention:update')).toBe(false);
  });

  it('is total: every role × operation returns a boolean (fail closed by default)', () => {
    for (const role of ROLES) {
      for (const op of OPERATIONS) {
        expect(typeof can(role, op)).toBe('boolean');
      }
    }
  });
});
