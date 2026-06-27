package kernel

import (
	"context"
	"time"
)

// This file declares the cross-service ports (interfaces only — no adapters).
//
// Convention (chosen once, applied uniformly — ADR-0002, overview.md §6):
//
//   - Every TENANT-SCOPED method takes `tc TenantContext` as its FIRST parameter.
//     Tenancy is the first-class invariant, so it leads the signature; there is
//     no un-scoped overload. AssertTenantScoped (fitness.go) mechanically proves
//     this for every port, and a contract test fails CI if a method regresses.
//   - `ctx context.Context` follows as the second parameter, carrying
//     cancellation/deadline only — not tenancy.
//
// Documented exceptions (the chicken-and-egg boundaries from model.md §4.5),
// where a tenant cannot yet exist:
//
//   - Authenticator.Authenticate — it PRODUCES the TenantContext from a
//     credential, so it cannot require one.
//   - Broker.Consume — the processor pulls a single multi-tenant queue; the
//     authoritative tenant rides in each Envelope and is re-asserted per message
//     before any tenant-scoped call (see EnvelopeHandler).

// LogStore is the hot-tier (Postgres) port: append normalized events, run hot
// searches, and read the tail-relevant recent window. Implemented by an adapter
// that arms RLS via WithTenantScope before every statement (ADR-0003, §4).
type LogStore interface {
	// Append persists events to the tenant's partitions of the hot store.
	Append(tc TenantContext, ctx context.Context, events ...LogEvent) error
	// Search runs a tenant-scoped, keyset-paginated hot query.
	Search(tc TenantContext, ctx context.Context, q SearchQuery) (SearchPage, error)
	// Tail returns the most recent events newest-first (the seed for live tail).
	Tail(tc TenantContext, ctx context.Context, q TailQuery) ([]LogEvent, error)
}

// Broker is the durable ingest pipeline (RabbitMQ) port carrying the Envelope
// published language (ADR-0004).
type Broker interface {
	// Publish enqueues an envelope for the tenant resolved at ingest.
	Publish(tc TenantContext, ctx context.Context, env Envelope) error
	// Consume drains the (multi-tenant) pipeline, invoking handler per message.
	// tc is the consuming principal (a platform_operator worker identity); the
	// adapter MUST build a fresh per-message TenantContext from env.TenantID and
	// pass THAT to the handler so all downstream access is correctly scoped.
	Consume(tc TenantContext, ctx context.Context, handler EnvelopeHandler) error
}

// EnvelopeHandler processes one delivered envelope. Its tc is reconstructed from
// the envelope's authoritative tenant_id, not from the consumer's identity.
type EnvelopeHandler func(tc TenantContext, ctx context.Context, env Envelope) error

// TailBus is the live-tail fan-out (Redis pub/sub) port. The channel is always
// `tail:{tenant_id}` derived from tc — never from user input (ADR-0006, §6).
type TailBus interface {
	// Publish fans an event out on the tenant's tail channel.
	Publish(tc TenantContext, ctx context.Context, event LogEvent) error
	// Subscribe streams the tenant's tail channel until ctx is cancelled.
	Subscribe(tc TenantContext, ctx context.Context) (<-chan LogEvent, error)
}

// ColdArchive is the durable cold tier (S3 Parquet via Glue/Athena) port. Every
// object/query is bound to the tenant's `tenant_id=<id>/` prefix (ADR-0005, §6).
type ColdArchive interface {
	// Archive tees events to the tenant's cold prefix.
	Archive(tc TenantContext, ctx context.Context, events ...LogEvent) error
	// Search runs a cold (Athena) query bound to the tenant partition predicate.
	Search(tc TenantContext, ctx context.Context, q SearchQuery) (SearchPage, error)
}

// KeyStore reads/revokes ingest API keys (ADR-0007). Lookups are tenant-scoped:
// the tenant slug is parsed from the presented key first, then RLS is armed, so
// even auth runs inside the tenant boundary (model.md §4.5).
type KeyStore interface {
	// Lookup returns the stored record for keyID within the tenant scope.
	Lookup(tc TenantContext, ctx context.Context, keyID string) (APIKey, error)
	// Revoke marks keyID revoked and is expected to bust any auth cache.
	Revoke(tc TenantContext, ctx context.Context, keyID string) error
}

// Authenticator verifies a presented credential and yields the TenantContext
// that drives isolation downstream. Adding OIDC later is a new implementation
// producing the same TenantContext (ADR-0007 §Extensibility).
//
// NOTE: Authenticate has no tc parameter ON PURPOSE — it is the boundary that
// establishes tenancy, so it cannot require it (allow-listed in the fitness
// test).
type Authenticator interface {
	Authenticate(ctx context.Context, cred Credential) (TenantContext, error)
}

// TenantStore is the tenant registry port (Identity & Access). The `tenants`
// table has no RLS, so access is governed by role here: a tenant reads only its
// own row; Create requires RolePlatformOperator (model.md §4.5).
type TenantStore interface {
	// Get returns the tenant by id (must equal tc.TenantID unless operator).
	Get(tc TenantContext, ctx context.Context, id TenantID) (Tenant, error)
	// Create provisions a new tenant; requires platform_operator.
	Create(tc TenantContext, ctx context.Context, t Tenant) error
}

// --- supporting value types -------------------------------------------------

// Credential is an opaque presented credential. Exactly one field is set.
type Credential struct {
	// APIKey is a raw ingest key, format lgk_<tenantPublicId>_<keyId>_<secret>.
	APIKey string `json:"api_key,omitempty"`
	// BearerToken is a raw UI session JWT.
	BearerToken string `json:"bearer_token,omitempty"`
}

// APIKey is the stored ingest-key record (never the plaintext secret).
type APIKey struct {
	ID        string     `json:"id"`
	TenantID  TenantID   `json:"tenant_id"`
	Scopes    []Scope    `json:"scopes,omitempty"`
	Hash      []byte     `json:"-"`
	RevokedAt *time.Time `json:"revoked_at,omitempty"`
}

// TenantStatus is the tenant lifecycle state.
type TenantStatus string

const (
	TenantActive    TenantStatus = "active"
	TenantSuspended TenantStatus = "suspended"
)

// Tenant is the registry record for a tenant.
type Tenant struct {
	ID       TenantID     `json:"id"`
	PublicID string       `json:"public_id"`
	Name     string       `json:"name"`
	Status   TenantStatus `json:"status"`
}

// Cursor is an opaque keyset position (ts, id) for stable pagination (§5.4).
type Cursor struct {
	TS time.Time `json:"ts"`
	ID string    `json:"id"`
}

// SearchQuery is a tenant-scoped hot/cold query. The tenant predicate is NOT a
// field here — it is bound from TenantContext by the adapter, so it can never be
// caller-controlled.
type SearchQuery struct {
	Text    string            `json:"text,omitempty"`
	Service string            `json:"service,omitempty"`
	Level   *Level            `json:"level,omitempty"`
	Labels  map[string]string `json:"labels,omitempty"`
	From    time.Time         `json:"from"`
	To      time.Time         `json:"to"`
	Cursor  *Cursor           `json:"cursor,omitempty"`
	Limit   int               `json:"limit,omitempty"`
}

// SearchPage is one keyset page of results.
type SearchPage struct {
	Events     []LogEvent `json:"events"`
	NextCursor *Cursor    `json:"next_cursor,omitempty"`
}

// TailQuery seeds a live-tail subscription with a bounded recent window.
type TailQuery struct {
	Limit int `json:"limit,omitempty"`
}

// TailChannel returns the Redis pub/sub channel for the tenant, derived from
// context (ADR-0006). A blank/invalid tenant yields an error — fail closed, no
// channel name is produced.
func TailChannel(tc TenantContext) (string, error) {
	if err := tc.Valid(); err != nil {
		return "", err
	}
	return "tail:" + string(tc.TenantID), nil
}

// ColdPrefix returns the S3 key prefix for the tenant's cold objects, derived
// from context (ADR-0005). Fail closed on a blank/invalid tenant.
func ColdPrefix(tc TenantContext) (string, error) {
	if err := tc.Valid(); err != nil {
		return "", err
	}
	return "tenant_id=" + string(tc.TenantID) + "/", nil
}
