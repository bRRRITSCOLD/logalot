import { z } from 'zod';

/**
 * RBAC roles (ADR-0007). Two are tenant-scoped grants stored in `memberships`
 * (`membership_role` enum, migration 000002); `platform_operator` is a
 * cross-tenant, platform-scope role modeled as `users.is_platform_operator` and
 * is deliberately NOT a membership — it must never carry tenant log content
 * (NFR-5.4).
 */
export const MEMBERSHIP_ROLES = ['tenant_admin', 'member'] as const;
export const ROLES = ['platform_operator', 'tenant_admin', 'member'] as const;

export const membershipRoleSchema = z.enum(MEMBERSHIP_ROLES);
export const roleSchema = z.enum(ROLES);

export type MembershipRole = z.infer<typeof membershipRoleSchema>;
export type Role = z.infer<typeof roleSchema>;
