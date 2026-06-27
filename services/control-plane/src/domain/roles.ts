// RBAC roles (ADR-0007 §RBAC). Mirrors the Go kernel (pkg/kernel/tenant.go), the
// `membership_role` enum (migration 000002), and the shared @logalot/contracts
// role schemas so the ubiquitous language is identical across services. The domain
// keeps its own copy (no transport dependency) — hexagonal purity.
//
//   - tenant_admin      manage a tenant: keys, users, retention.
//   - member            read/operate within a tenant (no admin verbs here).
//   - platform_operator cross-tenant, platform-scope; manages the tenant registry
//                        only and is structurally barred from tenant content
//                        (NFR-5.4). Modeled as users.is_platform_operator, NOT a
//                        membership.

export const ROLES = ['tenant_admin', 'member', 'platform_operator'] as const;
export type Role = (typeof ROLES)[number];

// Roles expressible as a tenant membership (the `membership_role` enum).
export const MEMBERSHIP_ROLES = ['tenant_admin', 'member'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
