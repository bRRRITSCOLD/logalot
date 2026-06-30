import type { Role } from './roles';

// The closed set of authorizable operations the control-plane exposes. Naming is
// `<resource>:<verb>` to match the scope/ubiquitous-language style of ADR-0007.
export const OPERATIONS = [
  'tenant:create',
  'tenant:read',
  'tenant:update',
  'tenant:delete',
  'tenant:list',
  'tenant:provision_admin',
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
  'savedquery:create',
  'savedquery:read',
  'savedquery:list',
  'savedquery:update',
  'savedquery:delete',
  'dashboard:create',
  'dashboard:read',
  'dashboard:list',
  'dashboard:update',
  'dashboard:delete',
  'invite:create',
  'invite:list',
  'invite:revoke',
] as const;

export type Operation = (typeof OPERATIONS)[number];

// The authorization matrix — the single source of truth for "who may do what".
// Defense-in-depth: this is consulted BOTH at the HTTP edge (route guard) and
// re-asserted inside sensitive application services (ADR-0007). RLS is an
// independent, orthogonal control on top of this.
//
// platform_operator owns the tenant registry AND may provision a tenant's FIRST
// admin (a credential-provisioning act, not reading tenant content). It is
// deliberately granted nothing else tenant-owned (users/keys/retention), so it can
// never reach tenant content (NFR-5.4). tenant_admin owns everything within its
// own tenant; member is read-mostly within its tenant.
const MATRIX: Record<Role, ReadonlySet<Operation>> = {
  platform_operator: new Set<Operation>([
    'tenant:create',
    'tenant:read',
    'tenant:update',
    'tenant:delete',
    'tenant:list',
    'tenant:provision_admin',
  ]),
  tenant_admin: new Set<Operation>([
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
    'savedquery:create',
    'savedquery:read',
    'savedquery:list',
    'savedquery:update',
    'savedquery:delete',
    'dashboard:create',
    'dashboard:read',
    'dashboard:list',
    'dashboard:update',
    'dashboard:delete',
    'invite:create',
    'invite:list',
    'invite:revoke',
  ]),
  // member is read-mostly within its tenant: it can SEE alert rules, saved
  // queries, and dashboards — but writing config is a tenant_admin verb.
  member: new Set<Operation>([
    'tenant:read',
    'retention:read',
    'alert:read',
    'alert:list',
    'savedquery:read',
    'savedquery:list',
    'dashboard:read',
    'dashboard:list',
  ]),
};

// can reports whether `role` is permitted to perform `operation`. Pure and total:
// an unknown role yields false (fail closed).
export function can(role: Role, operation: Operation): boolean {
  return MATRIX[role]?.has(operation) ?? false;
}
