// Package auth is the ingest API-key authentication adapter (ADR-0007), shared by
// ingest-service (#6) and query-service (#8). It implements the kernel
// Authenticator and KeyStore ports for opaque, hashed keys of the form
// lgk_<publicId>_<keyId>_<secret>.
//
// Resolution (model.md §4.5), the RLS-safe way:
//
//  1. parse the key (shape only) and SHA-256 the secret;
//  2. on a Redis cache hit (60s TTL), re-verify the secret in constant time
//     against the cached hash and return — Postgres is skipped, the check is not;
//  3. on a miss, resolve the tenant slug -> tenant_id (registry, no RLS), ARM RLS
//     (SET LOCAL app.tenant_id) and run a tenant-scoped SELECT by key id, so a key
//     belonging to another tenant is invisible (fail closed); constant-time
//     compare SHA-256(secret) to key_hash; reject revoked/expired; cache on
//     success only (no negative caching).
//
// Security invariants: the plaintext secret is never logged or stored (only its
// SHA-256); comparisons are constant time; the key lookup runs INSIDE RLS; all
// SQL is parameterized. Services MUST connect as the NOSUPERUSER logalot_app role
// (see pkg/platform) for the RLS backstop to apply.
package auth
