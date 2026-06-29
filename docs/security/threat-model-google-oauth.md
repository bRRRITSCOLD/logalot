# Threat Model — Google OAuth Sign-In (design-time)

- **Status:** Draft for lead-engineer review (PLAN-ONLY; seeds the implementation plan)
- **Date:** 2026-06-28
- **Author:** security-architect
- **Scope:** Track A of the Google OAuth + AWS IaC spec
  (`docs/superpowers/specs/2026-06-28-google-oauth-and-aws-iac-design.md`).
- **Anchors:** ADR-0007 (authn/authz), ADR-0002 (tenant isolation / RLS).
- **Not in scope:** Track B (AWS IaC) except where it carries the OAuth secret
  (client_secret in SSM) — covered as one boundary.

This is a STRIDE pass over the OIDC authorization-code flow and its trust
boundaries, ranked by likelihood × impact, then turned into numbered, testable
security requirements. Controls are proportionate to the ranked threat
(`principles-dry-kiss`): an invite-only, single-box PoC does not need a denylist
or an HSM, but it absolutely needs complete `id_token` validation and a
non-ambiguous tenant resolution, because those are the load-bearing invariants.

---

## 0. Load-bearing design decision — TENANT RESOLUTION (resolve before build)

**The problem.** `users` enforces `UNIQUE(tenant_id, email)`, so the *same email
can exist in several tenants as distinct user rows*. A Google `id_token` presents
only an `email` (+ `sub`). Resolving identity from `email`/`sub` alone is therefore
ambiguous across tenants — both at first link (which tenant's user row?) and at
subsequent login (the same Google account may be linked in several tenants).

**The decision (user, 2026-06-28).** A single Google account **MUST be able to
sign into multiple tenants**. The `oauth_identities` uniqueness constraint is
therefore **`UNIQUE(tenant_id, provider, provider_sub)`** (NOT global
`UNIQUE(provider, provider_sub)`). One Google account → at most one identity row
*per tenant*, and may legitimately hold rows in several tenants at once.

**The fact that makes this safe.** The password path is already **tenant-scoped**:
the login page collects a `tenantSlug` (`apps/web/src/routes/login.tsx`,
`packages/contracts/src/auth.ts → loginRequestSchema.tenantSlug`), and
`AuthService.login` resolves the user as `findCredentialsByEmail(tenant.id, email)`.
The OAuth path inherits the *same* tenant-scoping discipline: **every Google login
carries a tenant hint** (the slug) bound into the server-side single-use `state`
record from the tenant-scoped "Sign in with Google" page. **The tenant is ALWAYS
known before any lookup**, so RLS is armed for that one tenant and every resolution
runs inside it.

**Options considered**

| Option | How tenant is chosen | Verdict |
|---|---|---|
| A. **Tenant hint in `state`** from a tenant-scoped "Sign in with Google" page | User is on the tenant's login page (has the slug); the slug is bound into the server-side `state` record; RLS is armed for that tenant; both email match (first link) and `sub` match (subsequent) run scoped within it | **RECOMMENDED** — mirrors the password path exactly; no new trust surface; supports multi-tenant membership |
| B. Sub-based **global** resolution (e.g. SECURITY DEFINER lookup across tenants) | A `sub` resolves to "the" identity wherever it lives | **REJECT** — incompatible with multi-tenant membership (a `sub` now legitimately has many rows); requires a cross-tenant read that bypasses RLS; ambiguous |
| C. Reject any email that exists in >1 tenant | Only unambiguous emails can use Google | **REJECT** — defeats the multi-tenant-membership requirement |
| D. Email-domain → tenant mapping | Domain selects tenant | Explicitly out of scope (spec) |

**RECOMMENDATION — adopt Option A. The tenant from the verified `state` arms RLS;
ALL resolution happens within that one tenant:**

1. **First link (no `oauth_identities` row for this `sub` *in this tenant*):**
   resolve the user by `findCredentialsByEmail(state.tenant_id, id_token.email)` —
   scoped to the tenant carried in the verified `state`. No match in that tenant →
   **401, no session, no row written** (invite-only). Deterministic; the linking
   rule "cannot cross tenants" (spec §Security requirements) holds by construction.
2. **Subsequent logins:** resolve by `(provider, provider_sub)` **within the armed
   tenant** (RLS-scoped lookup; `state.tenant_id` is authoritative). Because the row
   is found only if it exists *in that tenant*, an identity linked in a *different*
   tenant is simply **invisible** to this lookup — there is no global resolver to
   abuse and nothing to cross-check. Not found in this tenant + no email match → 401.

There is deliberately **no global / SECURITY DEFINER `sub` resolver** in this
design: every lookup is RLS-scoped to the tenant the user explicitly chose.
Multi-tenant membership is an intended, supported outcome — the same Google account
may hold a distinct identity row (and a distinct session) in each tenant that has
independently provisioned and linked it. **Confirm `UNIQUE(tenant_id, provider,
provider_sub)` is encoded in migration `000016` before it is written.**

**Why this does not weaken account-takeover protection (assessed).** With one
Google account legitimately linkable in tenant A *and* tenant B, the question is
whether B's link can be abused to reach A (or vice versa). It cannot, for three
independent reasons, all testable:
- **Per-tenant invite-only provisioning.** A link is created only if the verified
  email already matches a user a `tenant_admin` provisioned *in that tenant*. The
  attacker cannot self-provision into a tenant they don't control, so they cannot
  manufacture a link there. (R2)
- **`email_verified=true` gate.** Linking requires Google to assert the email is
  verified, so an attacker cannot link an email they don't actually own. (R1)
- **Structural tenant isolation.** Each tenant's identity row, session, and RLS
  scope are independent; a session minted for tenant B carries only B's
  `tenant_id` claim and can never read A's data (ADR-0002). Holding a link in B
  conveys zero authority in A. (R3, R17)
The multi-tenant change therefore broadens *legitimate* reach (a real owner of the
Google account, separately invited to each tenant) without broadening an
attacker's reach.

---

## 1. Trust boundaries

| # | Boundary | Crosses | Trust assumption |
|---|---|---|---|
| TB1 | Browser ↔ web BFF | User-agent → TanStack server fns; httpOnly cookies (`lg_at`, `lg_rt`) | Browser is untrusted; cookies opaque to JS |
| TB2 | Browser ↔ Google authorize endpoint | The OAuth redirect (carries `client_id`, `redirect_uri`, `state`, `nonce`, `code_challenge`) | Redirect params are attacker-visible/forgeable |
| TB3 | web BFF ↔ control-plane | `POST /auth/oidc/google/callback` (forwards `code` + `state`) | Internal hop; still validate, don't trust |
| TB4 | control-plane ↔ Google token endpoint + JWKS | code→token exchange (client_secret), JWKS fetch | TLS to Google; JWKS keys rotate |
| TB5 | control-plane ↔ Postgres (RLS) | `oauth_identities`, `users`, `refresh_tokens` | RLS armed per tenant; no body-asserted tenant (ADR-0002) |
| TB6 | control-plane ↔ SSM Parameter Store | reads `client_secret` SecureString | IAM-gated; secret never leaves the box in cleartext logs |
| TB7 | Internet ↔ Caddy/TLS on EC2 | all of the above terminate here | Let's Encrypt TLS; single box |

---

## 2. STRIDE table (threat → boundary → likelihood/impact → mitigation)

Likelihood/Impact: L/M/H. Severity = the ranking used in §3.

| ID | STRIDE | Threat | Boundary | L | I | Severity | Mitigation |
|---|---|---|---|---|---|---|---|
| T1 | Spoofing | **id_token forgery / incomplete validation** — attacker presents a token not minted by Google, or with wrong `aud`/`iss`, or `alg:none`, and gets a session | TB4 | M | H | **Critical** | Verify signature against Google JWKS (RS256 only; reject `none`/HS*); `iss ∈ {accounts.google.com, https://accounts.google.com}`; `aud == client_id`; `exp` in future (+ small skew); reject if `email_verified != true`. (R1) |
| T2 | Elevation / Spoofing | **Cross-tenant account takeover via email/sub match** — email/sub resolution reaches a tenant the user wasn't invited to (e.g. via a global resolver) and mints a session there | TB5 | M | H | **Critical** | Tenant-scoped resolution (Option A): the verified `state.tenant_id` arms RLS; both first-link email match and subsequent `(provider, provider_sub)` match run **only within that tenant** — identities in other tenants are invisible. No global/SECURITY DEFINER `sub` resolver. Per-tenant invite-only provisioning + `email_verified=true` gate linking. (R2, R3, R17) |
| T3 | Tampering | **CSRF on the authorization request** — attacker fixes/forges `state`, injects their own `code`, links/logs the victim into the attacker's session (login CSRF) | TB1/TB2 | M | H | **Critical** | `state` is high-entropy, server-generated, **single-use**, stored server-side (Redis) with short TTL, bound to the browser (set as httpOnly cookie too) and to `tenant_id` + `nonce`; callback rejects unknown/expired/already-consumed `state`. (R4) |
| T4 | Spoofing / Replay | **id_token / code replay** — a captured `code` or `id_token` is replayed to mint a second session | TB2/TB3/TB4 | M | H | **High** | `nonce` server-generated, stored with the `state` record, asserted to equal `id_token.nonce`; `state`+`nonce` consumed atomically on first use (single-use); `code` exchanged exactly once (Google enforces, but treat exchange failure as terminal). (R5) |
| T5 | Spoofing | **Authorization-code injection** — attacker injects a code obtained in their own session into the victim's callback | TB2/TB3 | L | H | **High** | **PKCE (S256)** even though the client is confidential: `code_verifier` generated + stored server-side with the `state` record; sent at token exchange; Google rejects mismatched challenge. Defense-in-depth alongside `nonce`. (R6) |
| T6 | Tampering | **Open redirect on callback / redirect_uri** — `redirect_uri` or a post-login `returnTo` points off-domain, leaking code or phishing | TB1/TB2 | M | M | **High** | `redirect_uri` is a fixed server-side constant registered in Google console (never from request); any post-login `returnTo` validated against a same-origin allowlist (relative paths only). (R7) |
| T7 | Info disclosure | **client_secret exposure** — secret reaches the browser, logs, or an over-broad IAM role | TB6 | L | H | **High** | client_secret only in control-plane process memory, read from SSM SecureString; IAM policy scoped to the single parameter path (`ssm:GetParameter` on `/logalot/<env>/oauth/google/*`), no `ssm:*`; never logged; never in any response to web/browser. (R8) |
| T8 | Spoofing | **JWKS rotation / key-confusion** — control-plane caches a stale JWKS and rejects valid tokens, or fetches keys over a spoofable channel | TB4 | L | H | **High** | Fetch JWKS over TLS from Google's discovery doc; cache with bounded TTL + honor `kid`; on unknown `kid` refetch once; pin `alg=RS256`; never accept a key the token chooses (always select by `kid` from the fetched set). (R9) |
| T9 | Elevation | **Session fixation / refresh-family confusion** — OAuth login reuses an existing refresh family or doesn't establish a fresh one | TB1/TB5 | L | M | **Medium** | OAuth login mints a **new** refresh-token family (new `familyId`) and fresh access JWT via the SAME path as password login (`AuthService` mint), independent of any pre-existing cookie; old cookies overwritten. (R10) |
| T10 | DoS | **Callback flooding / JWKS fetch amplification** — unauthenticated POSTs to the callback force token-exchange + JWKS fetch load | TB3/TB4 | M | M | **Medium** | Rate-limit the callback endpoint (per-IP + global); a callback with no matching server-side `state` is rejected **before** any outbound Google call; JWKS cached (not fetched per request). (R11) |
| T11 | Info disclosure | **PII in logs** — `email`, `sub`, raw `id_token`, or `code` written to logs | TB3/TB6 | M | M | **Medium** | Never log `id_token`, `code`, `client_secret`, or full `email`; `sub`/`email` redacted or hashed in any diagnostic log; reuse AuthService's "never log secrets" discipline. (R12) |
| T12 | Spoofing | **Email mutation at Google** — user changes the email on a Google account, or an email is reclaimed, after first link | TB4/TB5 | L | M | **Medium** | Identity is pinned to `sub` after first link (not email); a changed email does NOT re-resolve to a different user; email used only at first-link match. (R13) |
| T13 | Spoofing | **Homograph / case / normalization on email** — `User@x.com` vs `user@x.com`, unicode look-alikes match the wrong row | TB5 | L | M | **Medium** | Normalize email (lowercase, trim, NFC) consistently on BOTH provisioning and OAuth match; compare normalized forms; do not unicode-fold beyond NFC (avoid false matches). (R14) |
| T14 | Repudiation | **No audit trail of link / login events** | TB5 | L | M | **Medium** | Emit an auth audit event on first-link (user_id, tenant_id, provider, sub-hash, ts) and on OAuth login/reject; sufficient for PoC forensics. (R15) |
| T15 | Tampering | **`code`/`state` over non-TLS or mixed content** | TB7 | L | H | **Medium** | Caddy enforces HTTPS (HSTS); cookies `Secure`; OAuth redirect URI is https-only (Google requires it). Existing `sessionCookieSecure()` already fails safe. (R16) |

---

## 3. Ranked, testable security requirements

Each is phrased so a test can assert it. **R-numbers are referenced by the STRIDE
table.** Rank: **Critical** must pass before merge; **High** before deploy;
**Medium** before GA / tracked.

### Critical

1. **R1 — Complete id_token validation.** Given an `id_token` with any of:
   bad/absent signature, `alg` ∈ {`none`, `HS256`}, `iss` not in
   {`accounts.google.com`,`https://accounts.google.com`}, `aud` ≠ configured
   `client_id`, `exp` in the past, or `email_verified` ≠ `true` — the callback
   returns **401, mints no access/refresh token, writes no `oauth_identities` row**.
   (One test per failing field.)
2. **R2 — First-link tenant scoping.** A first-time Google login whose verified
   `email` does **not** match a provisioned user in `state.tenant_id` returns
   **401 and writes no `oauth_identities` row**, *even if that email exists in a
   different tenant*. (Seed same email in tenant A and B; log in via B's page with
   the account provisioned only in A → 401, no row in B.)
3. **R3 — Resolution is tenant-confined (structural).** A Google login from a
   tenant's login page resolves **only** identities belonging to that tenant; an
   identity (same `sub`) linked in a *different* tenant is invisible to the lookup.
   (Link `sub` in tenant A; log in via tenant B's page where the account is **not**
   provisioned/linked → 401, no session — B cannot see A's identity row. There is no
   global `sub` resolver: assert the by-`sub` lookup is RLS-scoped to
   `state.tenant_id`.)
4. **R17 — Multi-tenant membership is supported and isolated.** A single Google
   account separately provisioned + linked in tenant A **and** tenant B can log into
   *each* via that tenant's login page, receiving a session whose `tenant_id` claim
   is exactly the tenant logged into; the session for B can never read A's data and
   vice versa. (Link the same `sub` in A and B; assert two successful logins, each
   minting a session scoped to the correct tenant; assert B's access token carries
   B's `tenant_id`, not A's.) Constraint: `UNIQUE(tenant_id, provider, provider_sub)`.
5. **R4 — CSRF / state integrity.** A callback with a `state` that is missing,
   unknown, expired, or already consumed returns **401 and mints no session**.
   A `state` is single-use: replaying the same valid `state` a second time returns
   401. `state` is ≥ 128 bits entropy and server-generated (not client-supplied).

### High

6. **R5 — Nonce replay protection.** A callback where `id_token.nonce` ≠ the nonce
   stored with the `state` record returns **401**. The nonce record is consumed
   atomically with `state` (a replayed callback finds nothing to consume → 401).
7. **R6 — PKCE enforced.** The authorization request includes a `code_challenge`
   (S256) whose `code_verifier` is stored server-side with the `state`; the token
   exchange sends the verifier. A flow with a missing/mismatched verifier fails the
   exchange and yields **401** (no session). (Verify the authorize URL contains
   `code_challenge` + `code_challenge_method=S256`.)
8. **R7 — No open redirect.** `redirect_uri` sent to Google equals the fixed
   server-configured value and is **not** read from the request. Any post-login
   `returnTo` is rejected unless it is a relative, same-origin path
   (`//evil.com`, `https://evil.com`, `\\evil.com` all rejected → fall back to default).
9. **R8 — client_secret confinement.** The `client_secret` never appears in any HTTP
   response body/header to web or browser, and never in logs. (Grep-style test over
   responses + a log-capture assertion.) IAM policy granting SSM read is scoped to
   the single Google-OAuth parameter path, not `ssm:*` / `Resource:*` (terraform
   plan/policy assertion).
10. **R9 — JWKS rotation handling.** With a rotated Google signing key, a token signed
   by the new `kid` validates after a single JWKS refetch; a token whose `kid` is in
   no fetched key set is **rejected**. The verifier selects the key by the token's
   `kid` from the fetched set (never trusts an embedded key), and accepts only RS256.

### Medium

11. **R10 — Fresh session on OAuth login.** A successful Google login issues a new
    refresh-token family (distinct `familyId`) and a fresh access JWT, regardless of
    any pre-existing `lg_rt`/`lg_at` cookie; pre-existing cookies are overwritten.
    (Assert new familyId; assert old refresh token is not reused.)
12. **R11 — Callback abuse resistance.** A callback request with no matching
    server-side `state` is rejected **before** any outbound call to Google
    (assert zero token-endpoint/JWKS calls on the bad path). The callback endpoint is
    rate-limited (assert 429 after threshold).
13. **R12 — No PII/secret in logs.** Across a full OAuth login, logs contain no raw
    `id_token`, `code`, `client_secret`, or full `email`; `sub`/`email` appear only
    redacted/hashed. (Log-capture assertion.)
14. **R13 — Identity pinned to sub.** After first link, changing the Google account's
    `email` still resolves to the SAME logalot user via `sub` (within its tenant); it
    does not match or create a different user row. (Login twice with same `sub`,
    different `email`.)
15. **R14 — Email normalization parity.** Email comparison at OAuth match uses the
    same normalization (lowercase + trim + NFC) as provisioning; `User@X.com` matches
    a user provisioned as `user@x.com`; no unicode folding beyond NFC.
16. **R15 — Auth audit events.** First-link and OAuth login/reject each emit an audit
    record containing `tenant_id`, `user_id` (on success), `provider`, hashed `sub`,
    outcome, timestamp. (Assert event emitted per outcome.)
17. **R16 — Transport security.** OAuth redirect URI and callback are https-only;
    session cookies carry `Secure` + `SameSite=Lax` + `HttpOnly` in any non-dev
    transport (existing `sessionCookieAttributes()` / `sessionCookieSecure()`).

---

## 4. State/nonce/PKCE store — design note (for the lead-engineer)

The spec's open question ("nonce/state in Redis vs signed cookies") interacts with
several requirements above. Recommendation: **store `state` server-side (Redis is
already deployed) as a single record** keyed by the `state` value, holding
`{ tenant_id, nonce, code_verifier, created_at }` with a short TTL (~5–10 min), and
**also** set the `state` value in an httpOnly cookie for browser-binding. This gives
single-use (delete-on-consume = atomic R4/R5), browser-binding (R3/R4), server-held
PKCE verifier (R6), and avoids putting the verifier/nonce in a client-readable place.
Generating `state`/`nonce`/`code_verifier` in the **control-plane** (not web) keeps
all secret material server-side and lets web stay a thin relay — preferred. Confirm
ownership (control-plane vs web BFF) during architecture.
</content>
</invoke>
