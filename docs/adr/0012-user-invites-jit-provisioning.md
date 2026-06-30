# ADR-0012: User invites + just-in-time provisioning

- **Status:** Accepted
- **Date:** 2026-06-30
- **Deciders:** systems architect (+ security-architect on the threat model, data architect on the `invites` schema)
- **Related:** spec [2026-06-30-user-invites-design](../superpowers/specs/2026-06-30-user-invites-design.md),
  ADR-0008 (Google OIDC sign-in, the `reject_no_provisioned_user` branch this replaces),
  ADR-0007 (`Authenticator` port, hashed high-entropy secrets, RBAC), ADR-0002 (tenant RLS isolation),
  ADR-0013 (`EmailSender` delivery abstraction), NFR-5,
  **[threat-model-user-invites](../security/threat-model-user-invites.md) (R-INV-1…R-INV-10) — authored separately**

## Context

Today the only way a Google account can sign into logalot is to be **hand-seeded** into the `users` table
first. The invite-only control lives in one place: `oidc-authenticator.ts` lines 285–290 —
`findCredentialsByEmail` returns null on a first Google login with no provisioned user, and the flow throws
`401 reject_no_provisioned_user`. There is no onboarding UX; every account requires a manual `INSERT`, which
blocks real end-to-end use.

We want tenant admins to **create and send invite links** so a new Google user can self-onboard, **without
weakening the invite-only control** — an unsolicited Google account still cannot get in. A valid, unexpired,
unconsumed, email-matched invite is the *only* thing that authorizes just-in-time (JIT) provisioning.

Forces:
- The control to preserve is precisely the `reject_no_provisioned_user` branch. The change must be a **surgical
  replacement of that one branch** — when no valid invite authorizes provisioning, the outcome is still 401.
- The `OidcAuthenticator` is, by ADR-0008/ADR-0007 design, **auth-agnostic about provisioning**: it resolves
  identity, mints sessions, and audits. Invite semantics (token model, expiry, single-use, email-binding) must
  **not** leak into it. They belong behind a port, the same way Google-secret handling lives behind the
  exchange/verify ports.
- Invites are tenant-owned data and must live under **FORCE RLS** (ADR-0002). But the invitee presents only a
  token at accept time — **no tenant** — and RLS forbids an unscoped, cross-tenant lookup (ADR-0008 explicitly
  rejected global resolvers and `SECURITY DEFINER` sub-lookups). The token must therefore **self-identify its
  tenant** so RLS can be armed before any scoped read, exactly as the API-key format does (ADR-0007).
- The token is a bearer credential shown once. It must be stored the way every other high-entropy secret in the
  system is stored (`api_keys.key_hash`, `refresh_tokens.token_hash`): **SHA-256 at rest, never plaintext, never
  logged** (ADR-0007, `domain/secret-hash.ts`).
- Concurrency: two browsers can race the same link. Provisioning must happen **at most once** (R-INV-3).
- Enumeration: accept failures (no such invite / expired / revoked / wrong email / already used) must be
  **indistinguishable to the invitee** — the same generic 401 as today (R-INV-6).

## Decision

### Where JIT provisioning lives — an `InviteProvisioner` collaborator, called only in the formerly-rejecting branch

The `OidcAuthenticator` stays auth-agnostic. We inject one new optional collaborator, `InviteProvisioner`, and
call it in **exactly** the branch that today throws `reject_no_provisioned_user`:

```
const userRecord = await deps.users.findCredentialsByEmail(tenantId, normalizedEmail);
if (!userRecord) {
  // Formerly: immediate 401. Now: a valid invite MAY authorize JIT provisioning.
  const provisioned = deps.inviteProvisioner
    ? await deps.inviteProvisioner.provisionFromInvite(tenantId, {
        email: normalizedEmail,
        inviteTokenHash,          // from the accept handshake cookie (route layer)
        providerSub: claims.sub,
        now: deps.clock.now(),
      })
    : null;
  if (!provisioned) {
    this.audit({ tenantId, userId: null, hashedSub, outcome: 'reject_no_valid_invite' });
    throw new UnauthorizedError('no provisioned account for this Google identity');
  }
  // continue exactly as the email-match path does today: linkFirst(providerSub) → mint session
}
```

The authenticator now knows only one new fact: "an optional invite token may accompany the callback; ask the
provisioner; `null` means reject." It learns **nothing** about expiry, single-use, hashing, or email-binding —
all of that is behind `InviteProvisioner` / `InviteRepository`. This keeps the hexagonal boundary ADR-0007/0008
established: the authenticator is an authentication source, not an invite engine.

The invite token reaches `handleCallback` the same way the browser-binding cookie does in ADR-0008: the
**accept handshake cookie** (httpOnly, `Secure`, `SameSite=Lax`, short Max-Age) is read at the HTTP/route layer
and threaded into `OidcCallbackCommand` (the route hashes it; the app core never sees plaintext). When no cookie
is present (a normal login, not an invite flow), `inviteTokenHash` is undefined and the behavior is byte-for-byte
the old control: 401.

### `InviteProvisioner` — one atomic, RLS-armed unit of work

`InviteProvisioner.provisionFromInvite` orchestrates the whole JIT sequence inside a **single tenant-armed
transaction** so a crash or a lost race can never leave a consumed invite with no user, or a user with no
membership:

1. **Atomic consume** (the gate, see below) — a conditional `UPDATE … RETURNING`. `0` rows ⇒ no valid invite
   ⇒ return `null` ⇒ authenticator throws the unchanged 401.
2. On a returned row: **create the user** (status `active`, Google-only — a non-verifiable placeholder password
   hash so the local-password path can never match), **create the membership** with the invite's role, and
   **`linkFirst`** the `oauth_identities` row for `providerSub`.
3. Emit an `invite_provisioned` audit event (hashed sub/email, never the raw token) and return `{ userId }`.

**Consistency requirement (load-bearing for the data/impl phase):** steps 1–3 must run in **one** transaction
armed with the state record's `tenant_id`. The existing repositories each open their own RLS transaction; the
provisioner needs them to **share one transaction client** (a unit-of-work / tx-scoped repository variant). This
is the one new structural seam this feature introduces and the impl plan must resolve it explicitly — do not
emulate atomicity with best-effort compensation.

The invite's role vocabulary is `member | admin` (the Invites context's ubiquitous language, per the spec). The
membership enum is `member | tenant_admin`. The provisioner performs an **explicit translation at the seam**
(`admin → tenant_admin`) rather than leaking either vocabulary across the boundary (principles-ddd).

### `InviteRepository` port + `Invite` domain entity

New driven port (matches the existing tenant-scoped repo shape — every method takes `tenantId` and runs under
`SET LOCAL app.tenant_id`):

```
interface InviteRepository {
  create(tenantId, input: NewInvite): Promise<Invite>;
  // Read-only liveness probe used at ACCEPT time (resolve tenant/UX); NOT the security authority.
  findValidByTokenHash(tenantId, tokenHash: Buffer, now: Date): Promise<InviteRef | null>;
  // The security authority: ONE atomic conditional UPDATE. Email-binding + status + expiry are
  // AND-conditions inside the statement; 0 rows ⇒ null ⇒ uniform 401 (no enumeration).
  consume(tenantId, input: { tokenHash: Buffer; email: string; now: Date }): Promise<ConsumedInvite | null>;
  listByTenant(tenantId): Promise<Invite[]>;
  revoke(tenantId, id: string, now: Date): Promise<boolean>;  // status flip, not delete
}
```

New domain entity `Invite` (public projection — never carries the token or its hash outward) + an `InviteToken`
value object (the one-time plaintext, held only long enough to return it in the create response). Fields mirror
the spec's `invites` row; the data architect finalizes the schema.

### Token model — 256-bit CSPRNG, tenant-self-identifying, SHA-256 at rest

- **Generation:** a 256-bit (32-byte) CSPRNG secret, the same entropy class as `state`/refresh secrets
  (`oidc-authenticator.ts` `STATE_BYTES`).
- **Wire format:** the token **self-identifies its tenant**, mirroring the API-key format
  `lgk_<tenantPublicId>_<keyId>_<secret>` (ADR-0007). Recommended shape: `lginv_<tenantPublicId>_<secret>`. The
  slug is **not** secret; it lets the accept route resolve the tenant and **arm RLS before any scoped lookup**,
  with no cross-tenant resolver (ADR-0008's structural rule). A wrong/forged slug simply finds no matching
  `token_hash` row → uniform 401. (Carrying the slug as a separate visible URL param is functionally
  equivalent; the embedded form is preferred for being self-contained and matching the established API-key
  pattern. The exact byte layout is a data/impl detail; the **architectural invariant** is: the token must
  identify its tenant.)
- **At rest:** store only `token_hash = sha256(secret)` (raw 32 bytes), `UNIQUE`. Reuse `domain/secret-hash.ts`
  byte-for-byte — no new hashing primitive. The plaintext is returned **once** in the create response and never
  persisted or logged (R-INV-2).
- **Lookup vs compare:** lookup is a direct indexed equality on `token_hash`, the standard pattern for
  high-entropy single-use tokens (password-reset style). Because we **probe by the hash** and never fetch-then-
  compare a stored secret, there is no secret-bearing comparison to time-attack; R-INV-2's constant-time
  requirement is satisfied structurally. (A 256-bit preimage cannot be recovered through B-tree probe timing.)

### Single-use via one atomic conditional UPDATE (consume = the authority)

Provisioning is gated by a **single statement** that folds find + email-match + single-use + expiry into one
atomic operation, keyed on the unique `token_hash`:

```sql
UPDATE invites
   SET status = 'consumed', consumed_at = now()
 WHERE token_hash = $1
   AND email      = $2            -- R-INV-1 email-binding (normalized id_token email)
   AND status     = 'pending'     -- R-INV-3 single-use / R-INV-5 not revoked
   AND expires_at > now()         -- R-INV-4 not expired
RETURNING id, role, email;
```

`0` rows back ⇒ **every** failure mode (no invite, wrong email, expired, revoked, already used, lost the race)
collapses to the same `null` ⇒ the same generic 401 (R-INV-6). Concurrent accepts serialize on the row; exactly
one wins (R-INV-3). This is a deliberate **refinement of the spec's two-step "find by `(tenant,email)` then
consume"**: keying the atomic consume on the **token_hash** removes the TOCTOU window, binds provisioning to the
exact link clicked, and yields uniform errors. With the one-pending-invite-per-`(tenant,email)` rule below, the
token-keyed and email-keyed forms converge for the happy path; token-keyed is simply more robust.

`findValidByTokenHash` exists only as a **read-only** accept-time liveness probe for UX (fail fast before
bouncing to Google) and returns the same generic outcome on any failure. It never consumes; the consume above
is the sole authority.

### Audit

The authenticator's `OAuthAuditOutcome` union gains **`reject_no_valid_invite`** (an invite was attempted and
failed) alongside the existing `reject_no_provisioned_user` (no invite token presented at all / provisioner
absent). Both are 401 to the invitee. The Invites context emits the lifecycle events `invite_created`,
`invite_revoked`, and `invite_provisioned` (hashed sub/email, never the raw token), per R-INV-9.

### Resolved open questions (architectural)

- **One `pending` invite per `(tenant, email)` — ENFORCE.** Add a partial unique constraint
  `UNIQUE (tenant_id, email) WHERE status = 'pending'`. Rationale: makes "the valid invite for this email"
  at-most-one and unambiguous; removes the "which of N pending roles wins?" question at provision; prevents
  accidental duplicate sprays. Re-inviting with a different role is "revoke (status flip) then create" — clean
  and auditable; the create API may expose a replace/upsert convenience. This is a structural decision → fix it
  now. (Defer the exact index expression to the data phase.)
- **Per-tenant outstanding-invite cap — ENFORCE a config-gated soft cap** (R-INV-10). `InviteService.create`
  counts `pending` invites for the tenant (under RLS) and rejects past `INVITE_MAX_OUTSTANDING_PER_TENANT`
  (default generous, e.g. 50 — high enough never to bother legitimate use, low enough to bound spray abuse).
  The control point (create-time count) is architectural and mandated here; the numeric default is ops config.
- **Revoke = status flip, not hard delete.** `revoke` sets `status = 'revoked'`; the row is retained for the
  audit trail and the admin list view. A janitor that prunes long-dead (`consumed`/`revoked`/expired) rows is a
  data-phase concern, not load-bearing here.

Purely-data questions (column types, index DDL, retention/cleanup cadence) are **deferred to the data phase**.

## Non-functional requirements

- **Latency / availability.** The returning-user login path (existing `oauth_identities` hit) is **unchanged —
  zero added cost**. The new work occurs *only* on a first Google login with no provisioned user: at accept,
  one optional indexed `findValidByTokenHash` probe; at the callback, **one atomic indexed `UPDATE`** (the
  consume) plus the user/membership/link writes the email-match path already performed. So p95 login latency is
  unaffected for the ~99% returning case, and the JIT case adds a single indexed conditional update. No new
  network hop, no new infra on the request path.
- **Security.** Cross-references the separately-authored
  [threat-model-user-invites](../security/threat-model-user-invites.md) (R-INV-1…R-INV-10): email-binding,
  256-bit hashed token, atomic single-use, server-side expiry, admin revoke kill-switch, uniform 401
  (no enumeration), RBAC-gated admin operations under RLS, audit. The security posture (trust boundaries,
  control selection) is owned by security-architect; this ADR provides the structural hooks those controls bind
  to.
- **Multi-tenant isolation.** `invites` is a tenant table: **FORCE ROW LEVEL SECURITY** scoped on `tenant_id`,
  consistent with every other tenant table (ADR-0002). The `UNIQUE (token_hash)` constraint is **global**
  (cross-tenant) and intentionally so — a 256-bit token is collision-free and global uniqueness leaks nothing
  (you cannot probe it under RLS). The consume always runs under RLS armed to the state record's tenant, so even
  a globally-unique token can only be consumed within its own tenant — and the slug-prefixed token guarantees
  that is the tenant the accept flow armed.
- **Cost.** Negligible. `invites` is a small, low-write table on the existing Postgres; no new managed service.
  Email delivery cost is addressed in ADR-0013 (~$0).

## Status

Accepted. JIT provisioning replaces **only** the `reject_no_provisioned_user` branch; the invite-only control is
preserved (no valid invite ⇒ 401). Token-keyed atomic consume, slug-prefixed tenant-self-identifying token,
one-pending-per-`(tenant,email)`, and a config-gated outstanding cap are the load-bearing choices. The
single-transaction provisioning unit-of-work is flagged to the impl phase as the one new structural seam.

## Consequences

### Positive
- **Surgical blast radius.** One branch in `oidc-authenticator.ts` changes; the rest of the auth flow, the
  session model, and every downstream context are untouched (realizes ADR-0007/0008's port design again).
- **Authenticator stays auth-agnostic.** Invite semantics live entirely behind `InviteProvisioner` /
  `InviteRepository`; the authenticator learns only "ask the provisioner; null ⇒ reject."
- **Strong concurrency + anti-enumeration posture from one statement.** The token-keyed atomic conditional
  UPDATE gives at-most-once provisioning and a uniform 401 for all failure modes, with no app-level locking.
- **Consistency with established patterns.** Token storage reuses `secret-hash.ts`; the slug-prefixed,
  RLS-arming token format mirrors API keys; the handshake-cookie carry mirrors ADR-0008's browser-binding
  cookie. No new primitives.
- **Invite-only control provably preserved.** When no valid invite exists, the path is byte-for-byte the old
  401.

### Negative / costs
- **A new transaction seam.** Atomic JIT requires the participating repositories to share one tenant-armed
  transaction — a unit-of-work the codebase does not yet have. Real work for the impl phase (called out
  explicitly so it is not discovered late).
- **`OidcCallbackCommand` grows one optional field** (`inviteTokenHash`) and the audit union gains one outcome
  — small, additive, but a touch to the hot auth type.
- **Two consume-shaped reads.** The optional accept-time `findValidByTokenHash` plus the callback consume means
  a live invite is read twice in the happy path. Cheap (indexed), and the probe is optional/UX-only.
- **Re-invite is a two-step (revoke then create)** under the one-pending rule — a minor admin-UX wrinkle,
  mitigable with a replace convenience in the create API.

### Trigger to revisit
- **Multiple concurrent invites per email** become a real need (e.g. inviting the same person to several roles
  pending their choice) → drop the partial unique constraint and rely on token-keyed consume (already robust to
  it — that is why we kept token-keying).
- **Non-Google providers / SCIM** arrive → generalize `InviteProvisioner` beyond the single first-link path.
- **Invite spray** is observed in audit despite the cap → move the cap from a static config to a rate-limited /
  per-admin budget.

## Alternatives considered

| Concern | Chosen | Alternative | Why chosen |
|---|---|---|---|
| Where JIT provisioning lives | `InviteProvisioner` collaborator called in the formerly-rejecting branch; authenticator stays auth-agnostic | A separate `POST /v1/invites/accept` endpoint that provisions, then a normal login | Keeps the invite-only control in its one existing place; no second auth surface to secure; the Google `id_token` email is the binding fact and it only exists inside the callback — a separate endpoint would have to re-establish trust in the email out-of-band |
| Token binding | **Email-bound** — `id_token` email (normalized) must equal the invite email, as an AND-condition in the consume | Open link (any Google account that opens it gets in) | R-INV-1: an intercepted link cannot onboard a *different* account; an open link makes the email channel a full bearer-grant with no second factor |
| Token storage | **SHA-256 at rest** (reuse `secret-hash.ts`), plaintext shown once | Store plaintext (or reversible-encrypted) | R-INV-2 + system-wide convention (api_keys, refresh_tokens): a DB read must never yield a usable credential; a 256-bit hash needs no slow KDF |
| Consume keying | **Token_hash**, single atomic conditional UPDATE (email/status/expiry as AND-conditions) | Spec's two-step: find by `(tenant,email)` then consume | Removes the TOCTOU window, binds provisioning to the exact link clicked, and yields a uniform 401 for all failure modes (R-INV-3, R-INV-6); converges with the one-pending rule on the happy path |
| Tenant resolution at accept (under RLS) | **Slug-prefixed token** `lginv_<slug>_<secret>` → arm RLS, then scoped lookup | Unscoped/global invite resolver or `SECURITY DEFINER` lookup by token | ADR-0008's structural rule: no cross-tenant resolver; the token self-identifying its tenant mirrors the API-key pattern and keeps every read RLS-scoped |
| Pending invites per `(tenant,email)` | **Enforce one** (partial unique) | Allow many | Unambiguous "the valid invite"; no role-ambiguity at provision; accidental-spray guard. Token-keyed consume keeps the door open to relax this later |
| Outstanding-invite abuse control | **Config-gated per-tenant soft cap** at create time | No cap / infra-level rate limit only | R-INV-10: cheap spray control with zero infra; default high enough to be invisible to legitimate use |
| Revoke semantics | **Status flip** to `revoked` | Hard delete | Audit retention (R-INV-9) and a meaningful admin list; pruning is a separate janitor concern |
