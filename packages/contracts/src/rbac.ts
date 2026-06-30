import type { Role } from './roles.js';

/**
 * CLIENT-MIRRORABLE RBAC matrix — a DISPLAY-ONLY mirror of the control-plane's
 * authoritative authorization matrix (services/control-plane/src/domain/rbac.ts).
 *
 * SECURITY: this exists ONLY so the UI can hide/disable actions a role cannot
 * perform (defense-in-depth UX). It is NEVER a security control. The server
 * re-checks every operation server-side and arms RLS underneath; a client that
 * forges a role still gets a 403. No data-fetch or authorization decision may rest
 * solely on this predicate — gate the fetch server-side.
 *
 * LIFT NOTE: the canonical matrix lives in the control-plane's server code, which
 * the client must not import (it would drag server-only deps into the browser).
 * We replicate the UI-relevant operations here as plain data. Keep in sync with
 * `domain/rbac.ts`; this is a deliberate, minimal duplication (the alternative —
 * a network round-trip to learn permissions — is worse for a display-only mirror).
 */
export const UI_OPERATIONS = [
  'tenant:read',
  'tenant:update',
  'user:create',
  'user:read',
  'user:list',
  'user:update',
  'user:delete',
  'apikey:create',
  'apikey:list',
  'apikey:revoke',
  'retention:read',
  'retention:update',
  'alert:create',
  'alert:read',
  'alert:list',
  'alert:update',
  'alert:delete',
  'invite:create',
  'invite:list',
  'invite:revoke',
] as const;

export type UiOperation = (typeof UI_OPERATIONS)[number];

// Mirrors the relevant rows of the control-plane MATRIX. platform_operator owns
// the tenant registry (its UI is out of MVP scope here); tenant_admin owns
// everything within its own tenant; member is read-mostly.
const MATRIX: Record<Role, ReadonlySet<UiOperation>> = {
  platform_operator: new Set<UiOperation>(['tenant:read', 'tenant:update']),
  tenant_admin: new Set<UiOperation>([
    'tenant:read',
    'user:create',
    'user:read',
    'user:list',
    'user:update',
    'user:delete',
    'apikey:create',
    'apikey:list',
    'apikey:revoke',
    'retention:read',
    'retention:update',
    'alert:create',
    'alert:read',
    'alert:list',
    'alert:update',
    'alert:delete',
    'invite:create',
    'invite:list',
    'invite:revoke',
  ]),
  member: new Set<UiOperation>(['tenant:read', 'retention:read', 'alert:read', 'alert:list']),
};

/**
 * Whether `role` is permitted to perform `operation`. Pure and total: an unknown
 * role yields false (fail closed). DISPLAY-ONLY — see the security note above.
 */
export function can(role: Role, operation: UiOperation): boolean {
  return MATRIX[role]?.has(operation) ?? false;
}
