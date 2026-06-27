import type { Role } from './roles';

// TenantContext is the immutable tenant + principal scope every tenant-scoped
// operation runs under. It is built ONCE, at the edge, from a verified credential
// (a session JWT for the UI), never from a request body — that is the cross-tenant
// leak ADR-0002 forbids. It mirrors the Go kernel's TenantContext so the isolation
// model has one consistent shape across services.
export interface TenantContext {
  readonly tenantId: string;
  readonly principalId: string;
  readonly role: Role;
  readonly scopes?: readonly string[];
}
