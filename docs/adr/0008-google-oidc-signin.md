# ADR-0008: Google OIDC sign-in integration

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** systems architect (+ security-architect on threat model, data architect on schema)
- **Related:** spec [2026-06-28-google-oauth-and-aws-iac-design](../superpowers/specs/2026-06-28-google-oauth-and-aws-iac-design.md) §Track A,
  ADR-0007 (`Authenticator` port, session mint), ADR-0002 (tenant isolation), overview.md §6, NFR-5,
  **[threat-model-google-oauth](../security/threat-model-google-oauth.md) (R4/R5/R6/R11, §4 store design note)**

## Context

ADR-0007 pre-built an `Authenticator` port and committed that "adding an OIDC/SAML adapter later is a new
`Authenticator` implementation that produces the same `TenantContext` — no downstream context changes." That
later is now. The product needs **Google sign-in**, additive to email/password, under an **invite-only**
model: a `tenant_admin` provisions the user first; Google login activates/links that pre-existing account.
Public self-serve signup and auto-tenant provisioning are explicitly out of scope (spec §Out of scope).

A single Google account **must be able to sign into multiple tenants** (multi-tenant membership): the same
human, invited into tenants A and B, signs into either via that tenant's login page. There is no "one Google
account → one user/tenant ever" limitation.

Forces:
- The OAuth **client_secret** must never reach the browser, so the token exchange and `id_token` verification
  must happen server-side in `control-plane` (the Identity & Access context, which already holds session
  minting). The `web` BFF holds only the public `client_id` + `redirect_uri`.
- Because one Google identity can be a member of several tenants, the **target tenant must be known before the
  lookup** — Google login alone is tenant-agnostic. The tenant is established at the **tenant-scoped login
  page** (a per-tenant path/subdomain) and carried tamper-proof through the redirect round-trip.
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
exchange, verifies the `id_token`, resolves the identity to an existing user **within the armed tenant**, and
returns the same `Principal`/`TenantContext` the password authenticator returns. The session-mint path (access
JWT + rotating refresh, httpOnly cookies, family reuse-detection) is reused verbatim — OIDC is an
authentication source, not a new session model.

### Endpoint and flow split (web BFF ↔ control-plane)
- **web BFF** owns the browser-facing half: serves the **tenant-scoped** login page, asks control-plane to
  **begin** the flow (passing the tenant slug), builds the Google `authorize` redirect from the returned
  parameters (it carries `client_id`, `redirect_uri`, `state`, `nonce`, `code_challenge`), sets the
  **browser-binding cookie** control-plane returns, and handles the callback route.
- **control-plane** owns the secret half and is the **authority for `state`/`nonce`/PKCE**:
  - `POST /auth/oidc/google/begin { tenant_slug }` → mints high-entropy `state`, `nonce`, and a PKCE
    `code_verifier`; computes `code_challenge = S256(code_verifier)`; **stores one Redis record** keyed by
    `state` = `{ tenant_id, nonce, code_verifier, created_at }` with a short TTL (~5–10 min); returns
    `{ authorize params (incl. code_challenge), browser-binding cookie value }` to the BFF.
  - `POST /auth/oidc/google/callback { code, state }` (+ browser-binding cookie) → **atomically
    consumes the Redis record** (delete-on-read; an absent/expired/already-consumed `state` is rejected
    *before* any outbound Google call), verifies the browser-binding cookie matches, **arms RLS to the
    record's `tenant_id`**, exchanges `code` at Google's token endpoint with the server-side `client_secret`
    **plus the record's `code_verifier`** (PKCE), and performs **full `id_token` validation**: signature
    against Google JWKS (cached), `iss ∈ {accounts.google.com, https://accounts.google.com}`,
    `aud == client_id`, `exp` not past, and `id_token.nonce ==` the record's `nonce`. It **requires
    `email_verified == true`** (an unverified email is an account-takeover vector and is rejected).

### PKCE (S256) — required
The authorization request always carries a `code_challenge` (S256) whose `code_verifier` is generated and
held **server-side in control-plane** (in the Redis record) and sent only at token exchange. This defends
against **authorization-code injection** (threat-model **T5 / R6**, High) and is OAuth 2.1 best practice even
though our client is confidential. The verifier must live at the token-exchange point (control-plane), which
is one reason `state`/`nonce`/PKCE are all minted and stored server-side rather than in the browser.

### state/nonce/PKCE storage — control-plane-minted, Redis-backed, single-use (+ browser-binding cookie)
`state`, `nonce`, and `code_verifier` live in **one Redis record minted by control-plane**, consumed
**atomically (delete-on-read)** on the callback — this is the single-use authority (threat-model **R4/R5**:
an absent/expired/already-consumed `state` is rejected; replay returns nothing). A **browser-binding cookie**
(httpOnly, `Secure`, `SameSite=Lax`, short Max-Age, set by control-plane via the BFF) is carried as a
**second factor** binding the callback to the browser that initiated the flow (threat-model **R3/R4**) — but
the cookie is *not* the single-use authority; Redis is.

The **tenant hint** is the `tenant_id` resolved from the tenant slug at `begin` time and stored **inside the
Redis record**, for both first-link and subsequent login. The user therefore cannot read or forge which
tenant they authenticate into; signing into a different tenant uses that tenant's login page → a separate
`begin` → a separate Redis record. control-plane reaches Redis behind an **`OAuthStateStore` port** (lead's
plan D1; in-memory fake for tests).

Why Redis over a cookie-only design: a signed/encrypted cookie is tamper-proof but **cannot by itself
guarantee single-use** — it is replayable until its TTL, so it cannot satisfy R4/R5/R11's requirement for
server-side atomic consumption, and it has nowhere safe to hold the PKCE `code_verifier` at the (server-side)
token-exchange point (R6). control-plane has no Redis dependency today, but the AWS box already runs a Redis
container (ADR-0009), so the **cost delta is ~$0** — the cookie's former "$0 / no-Redis" advantage does not
survive the single-use + server-held-verifier requirements. The threat model (§4), the lead's plan (D1), and
the security-architect all converge on Redis + PKCE.

### Account linking — invite-only, tenant-scoped, email→user on first link then sub
The tenant is **always known before lookup** (from the armed `tenant_hint`), so every read and write below is
**RLS-scoped to that single tenant**. There is no global, cross-tenant resolver and no `SECURITY DEFINER`
sub-lookup — the database simply cannot see another tenant's rows in this transaction.

- **Subsequent login:** look up `oauth_identities` by `(provider='google', provider_sub=<google sub>)` **within
  the armed tenant** (RLS-scoped). A hit resolves the member user → mint session.
- **First link:** no sub row in this tenant yet → match the verified `email` to a **provisioned** user **in
  this tenant**. **No match → 401** (invite-only, per tenant). Match → insert an `oauth_identities` row binding
  `(provider='google', provider_sub=<google sub>)` to that `user_id` under the armed `tenant_id`. Thereafter
  match by `sub`, so a later Google email change does not break or re-route the link.
- `oauth_identities` (data-architect to finalize) carries at least `{ id, tenant_id, user_id, provider,
  provider_sub, email_snapshot, created_at, last_login_at }`, is **RLS-scoped on `tenant_id`** like every
  tenant table (ADR-0002), and enforces **`UNIQUE(tenant_id, provider, provider_sub)`** — one Google identity
  per user per tenant. The **same Google `sub` may appear in multiple tenants** (one membership each); it is
  *not* globally unique.
- **Cross-tenant safety is structural:** the lookup and the insert run under RLS armed to `tenant_hint`, so a
  row linked in tenant A is physically invisible when authenticating into tenant B. The link can never resolve
  outside the tenant it was created in; "linked tenant == state tenant" is enforced by RLS, not by an
  application check.

## Status

Accepted. Google ships; the adapter is provider-shaped but no other provider (GitHub/Microsoft/SAML) is built
(YAGNI). Self-serve signup / auto-tenant provisioning remain out of scope.

**Open dependency flagged to data-architect + PM:** the spec assumed `oauth_identities` would be migration
`000016`, but `000016_retention_worker` already exists — the new migration must be **`000017`** (or later if
others land first). Confirm ordering in the data-model phase.

**Multi-tenant membership (load-bearing, for data-architect + web):** a single Google account can be a member
of multiple tenants. The target tenant is resolved from the **tenant-scoped login page** (the `tenant_id`
stored in the single-use server-side Redis state record), so email→user match need only be unique **within a
tenant** — the
existing per-tenant user-email uniqueness suffices; **no global email uniqueness is required**.
`oauth_identities` uses **`UNIQUE(tenant_id, provider, provider_sub)`** and is RLS-scoped, so the same Google
`sub` may hold one membership row per tenant. Two items follow: (1) `web` must expose a **tenant-scoped login
entry** (per-tenant path/subdomain) so the hint exists before the redirect; (2) the data-model phase confirms
the users-table per-tenant email uniqueness. No post-login tenant-picker is needed — the tenant is chosen by
which login page the user starts from.

## Consequences

### Positive
- Realizes ADR-0007's extensibility claim with **zero downstream change**: same `TenantContext`, same session
  tokens, same `query-service` authenticator. The blast radius is `control-plane` + `web` only.
- Matching on the immutable `sub` (after first email link) is resilient to Google email changes and is the
  OIDC-correct identity key.
- **Multi-tenant membership works without a tenant-picker**: the tenant comes from the login page and the
  `(tenant_id, provider, sub)` link is RLS-scoped, so one Google account cleanly signs into many tenants and
  cross-tenant resolution is structurally impossible.
- **Strong CSRF/replay/injection posture**: control-plane-minted `state`/`nonce` consumed atomically from
  Redis (true single-use, R4/R5/R11) + PKCE(S256) with a server-held verifier (R6) + a browser-binding cookie
  (R3/R4) — defense-in-depth that a cookie-only design cannot match.
- Invite-only with `email_verified` enforcement closes the unverified-email account-takeover path and keeps
  the PoC free of tenant-provisioning complexity.

### Negative / costs
- The web BFF and control-plane share a two-call contract (`begin` → authorize params + browser-binding
  cookie; `callback { code, state }` + cookie). It is small and explicit, but it is a new cross-service seam
  with two endpoints to test.
- **control-plane gains a Redis dependency** for the `OAuthStateStore` (it had none before). Mitigated by a
  port + in-memory fake for tests (lead D1); Redis already runs on the box (ADR-0009), so it is not a new
  deployable.
- `web` must serve a **tenant-scoped login page** (per-tenant path/subdomain) so the tenant is known at
  `begin` time — a small flow addition over a single generic login page.
- A real domain + HTTPS is on the critical path (Google rejects non-HTTPS redirect URIs) — this couples
  Track A's end-to-end demo to Track B's Caddy/ACME + Route53 (ADR-0010).

### Cost tradeoff
- **~$0** additional infrastructure. The `OAuthStateStore` uses the Redis container already running on the AWS
  box (ADR-0009) — no new managed service, no managed identity provider, no per-MAU SaaS auth bill. Google as
  IdP is free. (The single-use + server-held-verifier requirements are what removed the cookie-only design's
  former "$0 / no-Redis" edge — Redis is now load-bearing for security, not optional.)

### Trigger to revisit
- Add a **tenant-picker / account-chooser** step only if a user must select among tenants *after* Google auth
  (e.g. an "all my tenants" landing) — not needed for the per-tenant-login-page model chosen here.
- Add a **second OIDC provider** by cloning the adapter behind the same `Authenticator` port — only then,
  generalize provider config out of Google-specific code.

## Alternatives considered

| Concern | Chosen | Alternative | Why chosen |
|---|---|---|---|
| Code exchange / `id_token` verify | Server-side in control-plane (holds client_secret) | In the web BFF | client_secret must never be near the browser; control-plane already mints sessions |
| state/nonce/PKCE storage | **control-plane-minted Redis record, atomic single-use, + browser-binding cookie** | Signed+encrypted cookie only (no Redis) | Cookie alone is replayable — cannot guarantee single-use (R4/R5/R11) and has no safe server-side home for the PKCE verifier (R6); cookie-only is the rejected design, kept only as the *second-factor* binding |
| Authorization-code injection defense | **PKCE (S256), server-held `code_verifier`** | nonce only | Threat-model R6 (High) + OAuth 2.1 best practice; defense-in-depth alongside `nonce` even for a confidential client |
| Identity key after first link | Google `sub` via `(tenant_id, provider, provider_sub)` | Email each time | `sub` is immutable; email can change and is reassignable |
| Tenant resolution (multi-tenant) | Tenant-scoped login page → sealed `tenant_hint` → RLS-armed lookup | Global `(provider, sub)` resolver / post-login picker | One Google account → many tenants; RLS-scoped lookup is structurally cross-tenant-safe, no global resolver, no picker |
| Unmatched Google login | Reject 401 (invite-only) | Auto-provision user/tenant | Spec: self-serve + auto-provisioning out of scope; smallest, safest PoC |
| Unverified email | Reject (`email_verified` required) | Trust the email claim | Account-takeover vector; non-negotiable |
| Session after OIDC | Reuse ADR-0007 JWT + rotating refresh | New OIDC session model | Downstream must stay unchanged; one session model, one isolation input |
