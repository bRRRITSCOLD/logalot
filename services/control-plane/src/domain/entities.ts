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

export type AlertComparator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
export type AlertState = 'ok' | 'firing' | 'no_data';

// RuleQuery is the structured query a rule evaluates over its window. Mirrors the
// alert-evaluator's RuleQuery (Go) and the `query` jsonb column. No time range —
// the evaluator derives it from windowSeconds.
export interface RuleQuery {
  text?: string;
  service?: string;
  level?: string;
  labels?: Record<string, string>;
}

export type NotifyChannel = { type: 'webhook'; url: string } | { type: 'email'; to: string };

// SavedQuery is the public projection of a saved_queries row (migration 000007).
// Referenced by identity (id) from dashboards and alert_rules — no FK. All fields
// are mutable by the owner tenant; the query definition (queryText + filters) is
// what panels and alert rules resolve when the savedQueryId matches.
export interface SavedQueryFilters {
  service?: string;
  level?: string;
  labels?: Record<string, string>;
}

export interface SavedQuery {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  queryText: string;
  filters: SavedQueryFilters;
  timeRange: Record<string, unknown>;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Panel is the inline panel definition stored in dashboards.layout.
export interface Panel {
  id: string;
  type: 'timeseries' | 'stat' | 'logs';
  title: string;
  savedQueryId: string;
  viz: Record<string, unknown>;
  grid: { x: number; y: number; w: number; h: number };
}

// DashboardLayout is the inline layout JSONB stored in dashboards.layout.
export interface DashboardLayout {
  panels: Panel[];
}

// Dashboard is the public projection of a dashboards row (migration 000008).
// Panels are owned inline (aggregate boundary); panel savedQueryId references
// saved_queries by identity only.
export interface Dashboard {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  layout: DashboardLayout;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// OAuthProvider is the closed set of supported external OIDC providers. Only
// 'google' ships in v1; new providers are one-line ALTER TYPE additions in the DB.
export type OAuthProvider = 'google';

// OAuthIdentity is the public projection of an oauth_identities row (migration
// 000017). Invite-only: a row is written ONLY when the provider_sub's email
// matches an already-provisioned user inside the tenant. Identity is pinned to
// (provider, provider_sub) — email is a link-time snapshot, NOT a lookup key.
export interface OAuthIdentity {
  id: string;
  tenantId: string;
  userId: string;
  provider: OAuthProvider;
  providerSub: string;
  email: string;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// INVITE_STATUSES is the closed lifecycle state of an invite row. A pending
// invite may be consumed exactly once; expiry is enforced by comparing
// expires_at to now (no row is ever written with a stored 'expired' status —
// there is no expiry sweep). Mirrors the `invites.status` CHECK constraint
// (migration 000018) and the shared `inviteStatusSchema` (contracts/invite.ts)
// exactly. Keep all three in lockstep: a status value accepted here but not by
// the shared contract would reproduce the #208 `invitedBy`/`createdBy` class of
// bug the moment any code ever wrote it (issue #209).
export const INVITE_STATUSES = ['pending', 'consumed', 'revoked'] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

export function isInviteStatus(value: unknown): value is InviteStatus {
  return typeof value === 'string' && (INVITE_STATUSES as readonly string[]).includes(value);
}

// Invite is the public metadata projection of an invites row. It NEVER carries
// the plaintext token, secret, or secret hash — those are one-time values
// produced at creation only (see InviteToken in domain/invite.ts).
export interface Invite {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  status: InviteStatus;
  createdBy: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// InviteRef is a lightweight reference to an invite, suitable for embedding in
// events or audit records without pulling the full projection.
export interface InviteRef {
  id: string;
  tenantId: string;
  email: string;
}

// ConsumedInvite records the outcome of a successful atomic invite consumption:
// the invite id, the role and email from the row (for the provisioner to JIT-create the
// user and translate the role), and the timestamp the consume set consumed_at to.
// NEVER carries token, secret, or hash outward (ADR-0012, R-INV-2).
export interface ConsumedInvite {
  inviteId: string;
  role: string;
  email: string;
  consumedAt: Date;
}

// AlertRule is the public projection of an alert_rules row. The state +
// last_evaluated_at/last_triggered_at fields are owned by the alert-evaluator
// worker and are read-only here (the control-plane never writes them).
export interface AlertRule {
  id: string;
  tenantId: string;
  name: string;
  savedQueryId: string | null;
  query: RuleQuery;
  comparator: AlertComparator;
  threshold: number;
  windowSeconds: number;
  severity: string;
  enabled: boolean;
  notifyChannels: NotifyChannel[];
  state: AlertState;
  lastEvaluatedAt: Date | null;
  lastTriggeredAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}
