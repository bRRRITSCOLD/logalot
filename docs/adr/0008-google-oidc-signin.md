# ADR-0008: Google OIDC sign-in integration

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** systems architect (+ security-architect on threat model, data architect on schema)
- **Related:** spec [2026-06-28-google-oauth-and-aws-iac-design](../superpowers/specs/2026-06-28-google-oauth-and-aws-iac-design.md) §Track A,
  ADR-0007 (`Authenticator` port, session mint), ADR-0002 (tenant isolation), overview.md §6, NFR-5

## Context

ADR-0007 pre-built an `Authenticator` port and committed that "adding an OIDC/SAML adapter later is a new
`Authenticator` implementation that produces the same `TenantContext` — no downstream context changes." That
later is now. The product needs **Google sign-in**, additive to email/password, under an **invite-only**
model: a `tenant_admin` provisions the user first; Google login activates/links that pre-existing account.
Public self-serve signup and auto-tenant provisioning are explicitly out of scope (spec §Out of scope).

Forces:
- The OAuth **client_secret** must never reach the browser, so the token exchange and `id_token` verification
  must happen server-side in `control-plane` (the Identity & Access context, which already holds session
  minting). The `web` BFF holds only the public `client_id` + `redirect_uri`.
- The flow crosses a third-party redirect (browser → Google → browser → web → control-plane), so it needs
  **CSRF protection** (`state`) and **replay/binding protection** (`nonce`) that survive the round-trip and
  are **single-use**.
- Downstream — `TenantContext`, the `query-service` JWT authenticator, the kernel — must stay **unchanged**;
  the OIDC path must converge on the exact same access-JWT + rotating-refresh session that the password path
  mints (ADR-0007).
- Invite-only means a successful Google authentication that does **not** match a provisioned user must be
  **rejected (401)**, not auto-provisioned.

## Decision

### Adapter slots behind the ADR-0007 `Authenticator` port
Add an `OidcAuthenticator` (Google) implementation in `control-plane`. It performs the authorization-code
exchange, verifies the `id_token`, resolves the email to an existing user, and returns the same
`Principal`/`TenantContext` the password authenticator returns. The session-mint path (access JWT + rotating
refresh, httpOnly cookies, family reuse-detection) is reused verbatim — OIDC is an authentication source, not
a new session model.

### Endpoint and flow split (web BFF ↔ control-plane)
- **web BFF** owns the browser-facing half: renders "Sign in with Google", builds the Google `authorize`
  redirect (holds `client_id` + `redirect_uri` only), and handles the callback route. It generates `state`
  and `nonce`, and validates `state` on return.
- **control-plane** owns the secret half: `POST /auth/oidc/google/callback` receives `{ code, nonce }` from
  the BFF, exchanges `code` at Google's token endpoint using the server-side `client_secret`, and performs
  **full `id_token` validation**: signature against Google JWKS (cached), `iss ∈ {accounts.google.com,
  https://accounts.google.com}`, `aud == client_id`, `exp` not past, and `id_token.nonce == ` the BFF-supplied
  nonce. It **requires `email_verified == true`** (an unverified email is an account-takeover vector and is
  rejected).

### state/nonce storage — signed, encrypted httpOnly cookie on the web BFF (chosen)
`state` and `nonce` (plus the validated post-login `redirect_target`) are sealed into a **single short-lived
cookie** the web BFF sets when initiating the redirect: `httpOnly`, `Secure`, **`SameSite=Lax`** (Lax, not
Strict, so the cookie survives the top-level GET redirect back from Google), `Max-Age ≈ 600s`, integrity- and
confidentiality-protected (HMAC + encryption with a BFF key from SSM). On callback the BFF: (1) reads the
cookie, (2) checks `state` equals the returned `state`, (3) **deletes the cookie** (single-use), (4) forwards
`{ code, nonce }` to control-plane. control-plane checks `nonce` against the `id_token` claim.

Rationale over Redis: the `web` tier today touches **no** Redis (Redis is ingest/tail/cache infra on the Go
side); a cookie keeps the OAuth round-trip **stateless** and avoids coupling the BFF to a backing store
purely for in-flight auth state. It is correct under BFF horizontal scaling without sticky sessions (the
state travels with the client), costs **$0** additional infra, and is single-use by deletion. The cookie is
encrypted + signed so the client can neither read nor forge `state`/`nonce`. Reversibility: if we later need
server-side audit/revocation of in-flight attempts, the same `{state, nonce, redirect}` record moves into the
already-present Redis behind an internal interface — no flow change.

### Account linking — invite-only, email→user, then sub
- On callback, match the verified `email` to a **provisioned** user. **No match → 401** (invite-only).
- **First link:** insert an `oauth_identities` row binding `(provider='google', provider_sub=<google sub>)`
  to that `user_id`/`tenant_id`. Thereafter, **match by `(provider, provider_sub)`** — the immutable Google
  `sub`, not the mutable email — so a later Google email change does not break or re-route the link.
- `oauth_identities` (data-architect to finalize) carries at least `{ id, tenant_id, user_id, provider,
  provider_sub, email_snapshot, created_at, last_login_at }`, is **RLS-scoped on `tenant_id`** like every
  tenant table (ADR-0002), and enforces `UNIQUE(provider, provider_sub)`.
- **Cross-tenant safety:** a `(provider, provider_sub)` resolves to exactly one user/tenant for its lifetime;
  it can never be re-linked to a different tenant's user. See the **email-uniqueness assumption** below.

## Status

Accepted. Google ships; the adapter is provider-shaped but no other provider (GitHub/Microsoft/SAML) is built
(YAGNI). Self-serve signup / auto-tenant provisioning remain out of scope.

**Open dependency flagged to data-architect + PM:** the spec assumed `oauth_identities` would be migration
`000016`, but `000016_retention_worker` already exists — the new migration must be **`000017`** (or later if
others land first). Confirm ordering in the data-model phase.

**Assumption flagged to data-architect + PM (load-bearing):** email→user match is only deterministic if a
user's `email` is **globally unique** across tenants (one human = one provisioned user = one tenant for the
PoC). If the same email can exist in multiple tenants, the callback match is ambiguous and there is no tenant
hint in a Google login. The PoC **requires globally-unique user email** for any user who may use Google
sign-in; an ambiguous match is **rejected** pending a post-login tenant-selection flow (out of scope). This
must be reconciled with the existing users schema/uniqueness constraint in Phase 2.

## Consequences

### Positive
- Realizes ADR-0007's extensibility claim with **zero downstream change**: same `TenantContext`, same session
  tokens, same `query-service` authenticator. The blast radius is `control-plane` + `web` only.
- Matching on the immutable `sub` (after first email link) is resilient to Google email changes and is the
  OIDC-correct identity key.
- Stateless, $0-infra CSRF/replay protection that is correct under a scaled, sticky-session-free BFF.
- Invite-only with `email_verified` enforcement closes the unverified-email account-takeover path and keeps
  the PoC free of tenant-provisioning complexity.

### Negative / costs
- The web BFF and control-plane share a contract (`{code, nonce}` forwarding + the nonce-binding check). It is
  small and explicit, but it is a new cross-service seam to test.
- Email-uniqueness assumption constrains the user model; multi-tenant-per-identity needs a later tenant
  picker. Surfaced above rather than silently designed in.
- A real domain + HTTPS is on the critical path (Google rejects non-HTTPS redirect URIs) — this couples
  Track A's end-to-end demo to Track B's Caddy/ACME + Route53 (ADR-0010).

### Cost tradeoff
- **$0** additional infrastructure. Cookie-sealed state reuses the BFF's existing key material (SSM); no new
  Redis keyspace, no managed identity provider, no per-MAU SaaS auth bill. Google as IdP is free.

### Trigger to revisit
- Move state/nonce to **Redis** if server-side audit or active revocation of in-flight auth attempts becomes
  a requirement.
- Add a **tenant-selection** step (and relax global-email-uniqueness) when a single identity must span
  multiple tenants.
- Add a **second OIDC provider** by cloning the adapter behind the same `Authenticator` port — only then,
  generalize provider config out of Google-specific code.

## Alternatives considered

| Concern | Chosen | Alternative | Why chosen |
|---|---|---|---|
| Code exchange / `id_token` verify | Server-side in control-plane (holds client_secret) | In the web BFF | client_secret must never be near the browser; control-plane already mints sessions |
| state/nonce storage | Signed+encrypted httpOnly cookie (SameSite=Lax, single-use) | Redis-backed server-side record | KISS: BFF touches no Redis today; stateless, $0, correct under scale-out; Redis is the documented escape hatch |
| Identity key after first link | Google `sub` via `(provider, provider_sub)` | Email each time | `sub` is immutable; email can change and is reassignable |
| Unmatched Google login | Reject 401 (invite-only) | Auto-provision user/tenant | Spec: self-serve + auto-provisioning out of scope; smallest, safest PoC |
| Unverified email | Reject (`email_verified` required) | Trust the email claim | Account-takeover vector; non-negotiable |
| Session after OIDC | Reuse ADR-0007 JWT + rotating refresh | New OIDC session model | Downstream must stay unchanged; one session model, one isolation input |
