import type { MembershipRole } from './roles';

export type TenantStatus = 'active' | 'suspended' | 'deleted';

export interface Tenant {
  id: string;
  publicId: string;
  name: string;
  status: TenantStatus;
  createdAt: Date;
  updatedAt: Date;
}

// User is the public projection (never carries the password hash). The
// authentication path uses the separate AuthRecord (ports.ts) which is the only
// place a password hash leaves the persistence adapter.
export interface User {
  id: string;
  tenantId: string;
  email: string;
  displayName: string | null;
  status: string;
  isPlatformOperator: boolean;
  role: MembershipRole | null;
  createdAt: Date;
  updatedAt: Date;
}

// ApiKeyRecord is the stored, non-secret projection of an api_keys row. The
// plaintext key (and its secret) is shown exactly once at creation and never
// persisted (only sha256(secret) is — see migration 000005).
export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  name: string;
  scopes: string[];
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

export interface RetentionPolicy {
  tenantId: string;
  hotDays: number;
  coldDays: number;
  createdAt: Date;
  updatedAt: Date;
}
