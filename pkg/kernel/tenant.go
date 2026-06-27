package kernel

import (
	"context"
	"errors"
	"slices"
	"strings"
)

// TenantID is the canonical tenant identifier — a UUID string that matches the
// `tenant_id uuid` column used across the data model (docs/data/model.md). It is
// always the value the RLS GUC `app.tenant_id` is set from.
type TenantID string

// PrincipalID identifies the authenticated principal behind a request: a user id
// for UI sessions or an API key id for ingest (ADR-0007).
type PrincipalID string

// Role is the RBAC role carried by a principal (ADR-0007 §RBAC).
type Role string

const (
	// RoleTenantAdmin manages a tenant: keys, users, retention, alert rules,
	// dashboards.
	RoleTenantAdmin Role = "tenant_admin"
	// RoleMember can search, live tail, build dashboards, author alerts.
	RoleMember Role = "member"
	// RolePlatformOperator has platform-scope health/capacity/usage only and is
	// structurally barred from tenant log content.
	RolePlatformOperator Role = "platform_operator"
)

// Valid reports whether r is one of the known roles.
func (r Role) Valid() bool {
	switch r {
	case RoleTenantAdmin, RoleMember, RolePlatformOperator:
		return true
	default:
		return false
	}
}

// Scope is a fine-grained capability granted to a principal, e.g. "ingest:write".
type Scope string

// ScopeIngestWrite is the scope an ingest API key resolves to (ADR-0007).
const ScopeIngestWrite Scope = "ingest:write"

// TenantContext is the immutable tenant + principal scope that every
// tenant-scoped operation runs under. It is constructed once, at the edge, from
// a verified credential (ADR-0007) and is the single input to the four-layer
// isolation model (overview.md §6, ADR-0002).
//
// Tenant identity comes from the credential, NEVER from a request body or a
// free parameter a caller could spoof. That is why it is passed as a whole value
// and is the mandatory first argument of every tenant-scoped port method.
type TenantContext struct {
	TenantID    TenantID    `json:"tenant_id"`
	PrincipalID PrincipalID `json:"principal_id"`
	Role        Role        `json:"role"`
	Scopes      []Scope     `json:"scopes,omitempty"`
}

// ErrNoTenantContext is returned (or panicked in MustFromContext) when an
// operation that requires a tenant scope is reached without one. The whole point
// of the convention is to fail closed: no tenant ⇒ no access.
var ErrNoTenantContext = errors.New("kernel: no tenant context")

// ErrInvalidTenantID is returned when a TenantContext carries a TenantID that is
// not a well-formed UUID. A malformed id would be rejected by the `::uuid` cast
// in the RLS policy anyway; we fail fast in the kernel.
var ErrInvalidTenantID = errors.New("kernel: tenant id is not a valid uuid")

// Valid returns nil when the context carries a usable tenant scope. A blank
// TenantID fails with ErrNoTenantContext (fail-closed); a non-UUID TenantID
// fails with ErrInvalidTenantID.
func (tc TenantContext) Valid() error {
	if strings.TrimSpace(string(tc.TenantID)) == "" {
		return ErrNoTenantContext
	}
	if !isUUID(string(tc.TenantID)) {
		return ErrInvalidTenantID
	}
	return nil
}

// HasScope reports whether the principal was granted s.
func (tc TenantContext) HasScope(s Scope) bool {
	return slices.Contains(tc.Scopes, s)
}

// HasRole reports whether the principal holds role r.
func (tc TenantContext) HasRole(r Role) bool { return tc.Role == r }

// tenantContextKey is an unexported type so no other package can collide with or
// overwrite the value we stash in a context.Context.
type tenantContextKey struct{}

// WithTenant returns a child context carrying tc. Edge middleware calls this once
// per request so the scope propagates explicitly down the call stack — no
// globals, no ambient request-locals (overview.md §6 propagation contract).
//
// WithTenant does NOT validate tc: validation is deferred to the use-sites that
// actually scope an operation (TenantContext.Valid via ArmTenant / TailChannel /
// ColdPrefix), which all fail closed. Carrying is cheap; the boundary that uses
// the tenant is where a missing/invalid tenant is rejected.
func WithTenant(ctx context.Context, tc TenantContext) context.Context {
	return context.WithValue(ctx, tenantContextKey{}, tc)
}

// FromContext extracts the TenantContext carried by ctx. ok is false when no
// tenant has been attached — callers MUST treat that as deny (fail closed).
func FromContext(ctx context.Context) (TenantContext, bool) {
	tc, ok := ctx.Value(tenantContextKey{}).(TenantContext)
	return tc, ok
}

// MustFromContext returns the carried TenantContext or panics with
// ErrNoTenantContext. Use it only at trusted internal boundaries where the
// absence of a tenant is a programmer error, never on an untrusted path.
func MustFromContext(ctx context.Context) TenantContext {
	tc, ok := FromContext(ctx)
	if !ok {
		panic(ErrNoTenantContext)
	}
	return tc
}

// isUUID reports whether s is a canonical 8-4-4-4-12 lowercase/uppercase hex
// UUID. Kept dependency-free so the kernel imports nothing external.
func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !isHexDigit(c) {
				return false
			}
		}
	}
	return true
}

func isHexDigit(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}
