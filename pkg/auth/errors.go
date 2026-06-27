package auth

import "errors"

// All authentication failures collapse to a small set of sentinels. Callers
// (ingest-service #6, query-service #8) MUST treat any non-nil error as DENY and
// MUST NOT surface the distinction to clients — a single opaque "invalid
// credentials" response avoids an oracle that would let an attacker tell a
// malformed key from an unknown one from a wrong secret (enumeration defense).
// The distinct errors exist for server-side logs and tests only.
var (
	// ErrNoCredential is returned when no API key was presented at all.
	ErrNoCredential = errors.New("auth: no api key credential presented")
	// ErrMalformedKey is returned when the key fails shape validation (wrong
	// prefix, field count, or an empty field) — rejected before any DB work.
	ErrMalformedKey = errors.New("auth: malformed api key")
	// ErrUnknownKey is returned when the tenant slug or the key id does not
	// resolve to a live row (including the RLS fail-closed zero-rows case when the
	// presented slug does not own the key id).
	ErrUnknownKey = errors.New("auth: unknown api key")
	// ErrBadSecret is returned when the key id exists but the presented secret's
	// hash does not match (constant-time compare failed).
	ErrBadSecret = errors.New("auth: api key secret mismatch")
	// ErrRevokedKey is returned when the key has been revoked (revoked_at set).
	ErrRevokedKey = errors.New("auth: api key revoked")
	// ErrExpiredKey is returned when the key is past its expires_at.
	ErrExpiredKey = errors.New("auth: api key expired")
)
