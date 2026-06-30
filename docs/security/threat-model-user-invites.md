# Threat Model — User Invites (Google-native, invite-only preserved) (design-time)

- **Status:** Draft for lead-engineer review (PLAN-ONLY; seeds the architecture / data / implementation plan)
- **Date:** 2026-06-30
- **Author:** security-architect
- **Scope:** The user-invites feature
  (`docs/superpowers/specs/2026-06-30-user-invites-design.md`) — invite create / deliver /
  accept / consume-provision / manage, and the OIDC-callback branch it replaces.
- **Anchors:** ADR-0007 (authn/authz), ADR-0002 (tenant isolation / RLS).
  Extends `docs/security/threat-model-google-oauth.md` (R1..R17) — that model still governs the
  OIDC flow this feature plugs into; this document covers ONLY what the invite primitive adds.
- **Not in scope:** the OIDC flow itself (covered by the Google-OAuth model: id_token validation
  R1, tenant scoping R2/R3, CSRF/state R4, PKCE R6, JWKS R9, transport R16 — all still apply
  unchanged to the invite-driven login); non-Google IdPs; SCIM/directory sync; bulk invites.

This is a STRIDE pass over the invite lifecycle and its new trust boundaries, ranked by
likelihood × impact, then turned into numbered, testable security requirements that reuse and
extend the spec's `R-INV-*` identifiers. Controls are proportionate to the ranked threat
(`principles-dry-kiss`): an invite-only, single-box PoC does not need signed invite JWTs, a
revocation CRDT, or an email DKIM-reputation pipeline — but it absolutely needs an
**email-bound, single-use, atomically-consumed** token and a **role read only from the server-side
invite row**, because those are the load-bearing invariants that keep "invite-only" true.

---

## 0. Load-bearing design decision — THE INVITE IS AN AUTHORIZATION GRANT (resolve before build)

**The problem.** Today the invite-only control is a hard wall: `findCredentialsByEmail` → null →
`401 reject_no_provisioned_user` (`oidc-authenticator.ts:287-290`). This feature deliberately
**opens that wall** — a valid invite now causes a *write* (create user + membership + link
identity) where previously there was only a reject. The invite token therefore becomes a
**bearer authorization grant that mints a brand-new principal with a chosen role**. Every property
that made the wall safe must be re-established as a property of the token, or "invite-only"
silently degrades into "anyone-with-a-link" or "anyone-who-can-guess".

**The decision.** The invite does NOT authorize on possession of the link alone. Provisioning
fires only when **all** of the following hold, checked server-side at the previously-rejecting
branch, inside the tenant that the invite row names:

1. the token presented hashes to a stored `token_hash` (R-INV-2),
2. the matching invite is `status='pending'` and `expires_at > now()` (R-INV-4, R-INV-5),
3. the verified Google `id_token` email (normalized) **equals** the invite's bound email (R-INV-1),
4. the atomic single-use consume wins the row (R-INV-3),
5. the granted membership role is read **from the invite row**, never from any client input (R-INV-8/16).

**The fact that makes this safe.** The OIDC model already proves identity (`email_verified=true`,
full id_token validation — R1) and already arms RLS for exactly one tenant from the verified
`state` (R2/R3). The invite reuses both: the tenant comes from the invite (carried through the
same server-side `state` record), and the email is checked against Google's *verified* email — so
an intercepted or forwarded link cannot onboard an account the holder does not actually control.
The invite adds authorization *to provision*; it never weakens authentication.

**The single non-negotiable invariant.** *No code path may create a user, membership, or identity
link except by atomically consuming a pending, unexpired, email-matched invite in the tenant that
owns it.* If any of {token match, status, expiry, email match, atomic consume, role-from-row} is
skipped or evaluated against client-supplied data, invite-only is broken. Every Critical
requirement below is a facet of this one invariant.

---

## 1. Trust boundaries

The invite feature adds boundaries TB-I1..TB-I4 on top of the OAuth model's TB1..TB7.

| # | Boundary | Crosses | Trust assumption |
|---|---|---|---|
| TB-I1 | Admin browser ↔ web BFF ↔ control-plane | `POST /v1/invites` (create), `GET /v1/invites` (list), `POST /v1/invites/:id/revoke` | Admin is authenticated; the **plaintext token exists only in the create response and is shown once** — it must not be logged, cached, or re-readable |
| TB-I2 | Invitee browser ↔ `/invite/accept` route | `?token=…` query param → short-lived httpOnly handshake cookie → existing OIDC authorize | Invitee is **fully untrusted**; the token is attacker-influenceable; the URL is the highest-leakage surface (history, Referer, logs, forwarding) |
| TB-I3 | control-plane ↔ Postgres (RLS) | `invites` table writes/reads; atomic consume; user+membership+identity creation | RLS armed per tenant from the verified `state`; tenant is **never** body-asserted (ADR-0002); the consume is the concurrency guard |
| TB-I4 | control-plane ↔ Email provider (SES/SMTP) | invite email send (address + rendered template), gated by `EMAIL_PROVIDER` | Provider endpoint is **fixed config, never request-derived** (no SSRF); the recipient address and any interpolated field are untrusted input to an injection sink (SMTP headers / template) |

---

## 2. Data-flow over the invite lifecycle

```
                         ADMIN (authenticated, invite:create)
                                   │
   (1) CREATE  ───────────────────▼───────────────────────────────────────────  TB-I1
        POST /v1/invites {email, role}
        ├─ RBAC gate: invite:create  ── RLS tenant = session claim (NOT body)
        ├─ secret = CSPRNG(256-bit);  token_hash = sha256(secret)
        ├─ INSERT invites(tenant_id, email_norm, role∈{member,admin},
        │                 token_hash, status='pending', expires_at=now()+7d, created_by)
        └─ RETURN { invite, inviteUrl(secret) }   ← plaintext shown ONCE
                                   │
   (2) DELIVER  ───────────────────┼─────────────────┐
        link always returned       │                 │ (optional, if EMAIL_PROVIDER)
        (admin copies / shares)    │                 ▼  TB-I4
                                   │        EmailSender.send(to=email, link)
                                   │        (fire-and-forget; failure ≠ create failure)
                                   ▼
   (3) ACCEPT  ────────────────────▼───────────────────────────────────────────  TB-I2
        invitee opens /invite/accept?token=…   (UNTRUSTED)
        ├─ strip token from URL → short-lived httpOnly handshake cookie
        ├─ Referrer-Policy: no-referrer ; no token in any onward redirect
        └─ start existing OIDC authorize (tenant from the invite, no workspace prompt)
                                   │
                              [ Google sign-in — OAuth model R1/R4/R6 unchanged ]
                                   │
   (4) CONSUME + PROVISION ────────▼───────────────────────────────────────────  TB-I3
        OIDC callback, at the former reject_no_provisioned_user branch:
        findCredentialsByEmail == null  AND  no oauth_identity for sub
        ├─ find pending invite by (token_hash, tenant, status='pending', not expired)
        ├─ email match:  normalize(id_token.email) == invite.email   else → 401 (NOT consumed)
        ├─ ATOMIC consume: UPDATE invites SET status='consumed', consumed_at=now()
        │                  WHERE id=$1 AND status='pending' AND expires_at>now() RETURNING …
        │                  0 rows ⇒ lost race / revoked / expired ⇒ fall through to 401
        ├─ create user (active, disabled-password placeholder)
        ├─ create membership(role = invite.role)         ← role from ROW, never client
        ├─ linkFirst oauth_identity (R13 conflict handling preserved)
        └─ all-or-nothing transaction → mint session
                                   │
   (5) MANAGE  ────────────────────▼───────────────────────────────────────────  TB-I1
        GET /v1/invites (list)  /  POST /v1/invites/:id/revoke
        ├─ RBAC gate: invite:list / invite:revoke
        ├─ RLS tenant = session claim; object lookup scoped to that tenant
        └─ revoke = status flip to 'revoked' (kill-switch; same atomic consume sees it)
```

Trust transition points (where untrusted data hits a decision or a sink): **(3)** the token in a
URL, **(4)** the email-match decision + the atomic consume + the role source, **(5)** the
object-id in a revoke/list path, and **(2/4-I4)** the recipient address and template fields handed
to the email provider.

---

## 3. STRIDE table (threat → boundary → likelihood/impact → mitigation)

Likelihood/Impact: L/M/H. Severity = the ranking used in §4.

| ID | STRIDE | Threat | Boundary | L | I | Severity | Mitigation |
|---|---|---|---|---|---|---|---|
| TI-1 | Spoofing / Elevation | **Link interception → onboarding a different account.** A leaked/forwarded link is opened by someone other than the intended invitee; provisioning would mint *their* account with the invited role. | TB-I2/TB-I3 | M | H | **Critical** | Email-bound: provision only when normalized `id_token.email` == invite email (R1 guarantees the email is Google-*verified*). A holder who can't sign in as that verified email cannot onboard. (R-INV-1) |
| TI-2 | Spoofing | **Token guessing / brute-force.** Attacker enumerates accept tokens to provision without an invite. | TB-I2/TB-I3 | L | H | **Critical** | 256-bit CSPRNG secret (infeasible to guess); stored only as `sha256` (`token_hash`), unique; lookup by hash; constant-time compare; never the secret at rest. (R-INV-2) |
| TI-3 | Tampering / Elevation | **Replay / double-use race.** Two concurrent accepts (or a re-opened link) provision twice, or race a revoke/expiry to slip through. | TB-I3 | M | H | **Critical** | Single atomic conditional UPDATE `WHERE status='pending' AND expires_at>now()` is BOTH the validity check and the consume; 0 rows ⇒ clean 401 fall-through. Validity and consume can't be split. (R-INV-3) |
| TI-4 | Elevation | **Privilege escalation via role.** Granted role comes from a tampered request field, the id_token, or a client hint instead of the invite; or consuming an `admin` invite mutates an existing user's role. | TB-I3 | M | H | **Critical** | Membership role is read **only** from the stored invite row (`role∈{member,admin}` CHECK); the accept request carries no role; `admin`-role invites require `invite:create`; consumption provisions **NEW** users only — it never touches an existing user/membership (the branch runs only when `findCredentialsByEmail==null`). (R-INV-8) |
| TI-5 | Authorization / Tampering | **Cross-tenant IDOR on manage.** Admin of tenant A revokes/reads an invite id belonging to tenant B by guessing/replaying its uuid. | TB-I1/TB-I3 | M | H | **Critical** | List/revoke run under RLS armed from the **session** tenant claim (never body/path-asserted); a cross-tenant `:id` resolves to zero rows → generic 404; no leak of existence. (R-INV-15, R-INV-7) |
| TI-6 | Authorization | **Missing/weak authz on create/list/revoke.** A member (or unauthenticated caller) creates or revokes invites. | TB-I1 | M | H | **Critical** | `invite:create` / `invite:list` / `invite:revoke` gated through existing RBAC `can()`; invites are tenant-scoped under FORCE RLS; cross-tenant create is impossible by construction. (R-INV-7) |
| TI-7 | Info disclosure | **Token leakage via URL — accept page.** The `?token=` lands in browser history, is sent as the `Referer` on outbound requests from the accept page, or is forwarded with the URL. | TB-I2 | H | M | **High** | Accept route immediately moves the token into a short-lived httpOnly handshake cookie and **strips it from the visible URL** (server redirect / history replace to a clean path); sets `Referrer-Policy: no-referrer` on the accept response; the token is **never** placed in the onward OIDC redirect to Google. (R-INV-11) |
| TI-8 | Info disclosure | **Token leakage via server/proxy logs.** The token query string is captured in Caddy/access logs, BFF request logs, or the control-plane; or the one-time create response is logged. | TB-I1/TB-I2/TB7 | M | H | **High** | Accept passes the token to the BFF/control-plane in a **request body, not a query string**; access-log config excludes query strings (or the token param) for `/invite/accept`; the plaintext secret and `token_hash` are on a never-log denylist; the create response body is not logged. (R-INV-12) |
| TI-9 | Tampering / Info disclosure | **Email header / template injection.** A crafted recipient address or interpolated field carries CRLF (SMTP header injection → extra Bcc/Subject) or HTML/template markup (content injection / phishing) into the sent mail. | TB-I4 | M | M | **High** | Recipient validated to a strict email grammar; **reject CR/LF and C0 control chars** in the address and any interpolated field; emails built via the provider SDK's structured params (never string-concatenated headers); template engine auto-escapes; the only link is server-built from `token + fixed base URL`, no user-controlled URLs. (R-INV-13) |
| TI-10 | Tampering / Atomicity | **Half-provisioned state.** Consume succeeds but user/membership/link creation fails (or vice-versa), leaving a burned invite with no usable account, or an account with no membership/role. | TB-I3 | L | H | **High** | The consume + create-user + create-membership + linkFirst run in **one transaction**; any failure rolls back the consume so the invite stays `pending` and no orphan principal is created; the existing `linkFirst` ConflictError path (R13) rolls back rather than re-linking. (R-INV-17) |
| TI-11 | DoS / Spoofing | **Invite spray / enumeration / accept flooding.** Mass create to spam invitees, or high-volume accept attempts to brute-force or to amplify Google/email calls. | TB-I1/TB-I2/TB-I4 | M | M | **High** | Reuse the OIDC callback rate-limit on the accept path; rate-limit `POST /v1/invites`; per-tenant cap on outstanding `pending` invites; an accept with no matching `token_hash` is rejected **before** any outbound Google/email call. (R-INV-10) |
| TI-12 | Info disclosure | **Enumeration oracle on accept.** Distinct errors ("no such invite" vs "expired" vs "wrong email" vs "revoked") let an attacker probe invite/email state. | TB-I2 | M | M | **High** | Every invalid accept returns the **same** generic `401 reject_no_valid_invite` (identical body + status + timing class) as the pre-existing `reject_no_provisioned_user` — no distinction surfaced to the invitee. (R-INV-6) |
| TI-13 | Tampering | **Stale invite acceptance.** A long-lived link is accepted weeks later. | TB-I3 | M | M | **High** | Expiry mandatory (NOT NULL `expires_at`, default 7d), enforced server-side inside the atomic consume; no client can extend it. (R-INV-4) |
| TI-14 | Tampering | **Revoked invite still works.** A revoked invite is accepted due to a check/consume gap. | TB-I3 | L | H | **High** | Revoke flips `status='revoked'`; the atomic consume's `WHERE status='pending'` excludes it in the same statement — there is no window where a revoked invite provisions. (R-INV-5) |
| TI-15 | Info disclosure | **Token leakage via email forwarding.** The invitee forwards the invite email; a third party clicks. | TB-I2 | M | M | **Medium** | Defense-in-depth of TI-1/TI-3/TI-13: email-bound (forwarder's Google email won't match), single-use (already-consumed → 401), expiry (stale → 401). No new control; asserted as a derived test. (R-INV-18) |
| TI-16 | Spoofing / SSRF | **Email-send SSRF / outbound abuse.** A request influences the provider endpoint, or send is used to probe internal hosts / amplify traffic. | TB-I4 | L | M | **Medium** | Provider endpoint + credentials are **fixed config (`EMAIL_PROVIDER`), never request-derived**; send targets only the invite's bound, validated address; send is rate-limited with create; the HTTP/auth layers never see provider secrets (port boundary). (R-INV-14) |
| TI-17 | Tampering | **Tenant / returnTo confusion at accept.** The invitee supplies a tenant or a post-login `returnTo` that redirects them into the wrong tenant or off-domain. | TB-I2 | L | M | **Medium** | Tenant is read **from the invite row server-side**, never from an invitee-supplied param; any `returnTo` on the accept route passes the existing same-origin relative-path allowlist (`sanitizeReturnTo`, `oidc-authenticator.ts:414`). (R-INV-20) |
| TI-18 | Repudiation / Info disclosure | **No / leaky audit trail.** No record of create/revoke/provision/reject, or the audit log itself leaks the raw token, sub, or full email. | TB-I3 | M | M | **Medium** | Emit `invite_created`, `invite_revoked`, `invite_provisioned`, `reject_no_valid_invite`; records carry tenant, actor/user id, hashed sub, and outcome — **never** the raw token (at most an invite id), and sub/email hashed exactly as the OAuth model already does (`hashProviderSub`, R12/R15). (R-INV-9) |

---

## 4. Ranked, testable security requirements

Each is phrased so a test can assert it; **R-INV-numbers are referenced by the STRIDE table** and
reuse the spec's seeds (R-INV-1..10), extended with R-INV-11..20. Rank: **Critical** must pass
before merge; **High** before deploy; **Medium** before GA / tracked.

### Critical

1. **R-INV-1 — Email-bound provisioning (link interception).** A valid, pending, unexpired invite
   presented with a Google `id_token` whose normalized email ≠ the invite email returns
   **401 `reject_no_valid_invite`, writes NO user / membership / identity, and DOES NOT consume the
   invite** (it stays `pending`). *Test:* create invite for `a@x.com`; complete sign-in as
   `b@x.com`; assert 401, assert invite row still `pending`, assert no new user/membership/oauth row.
2. **R-INV-2 — Token unguessable + hashed-at-rest.** The accept secret is ≥256-bit CSPRNG; the
   `invites` row stores only `sha256(secret)` (`token_hash`, unique), never the plaintext; lookup is
   by hash with a constant-time compare. *Test:* assert stored column has no plaintext token; assert
   token length/entropy; assert a wrong token never matches (and matching is not byte-by-byte
   short-circuit timing-observable).
3. **R-INV-3 — Atomic single-use consume (replay/double-use + race).** Two concurrent accepts of the
   same valid invite provision **exactly once**; the consume is a single conditional UPDATE
   (`WHERE status='pending' AND expires_at>now() RETURNING`), and a 0-row result yields a clean 401
   with no partial write. *Test:* fire two concurrent accepts → exactly one 201/session, one 401,
   one user, one membership; assert a second sequential accept of a consumed invite → 401.
4. **R-INV-7 — Authz on create/list/revoke + tenant scoping.** `invite:create` / `invite:list` /
   `invite:revoke` are required; a member or unauthenticated caller is rejected; every invite
   statement runs under FORCE RLS scoped to the session tenant (never a body/path tenant). *Test:*
   member token → 403 on each op; cross-tenant create attempt writes nothing.
5. **R-INV-8 — Privilege-escalation safe role.** The granted membership role is read **only** from
   the stored invite row (DB CHECK `role∈{member,admin}`); the accept request carries no role and
   cannot influence it; creating an `admin`-role invite requires `invite:create`; consumption
   provisions a **new** user only and never mutates an existing user's role/membership. *Test:*
   tamper any client field to inject `role=admin` on a `member` invite → resulting membership is
   `member`; assert the accept path is never reached when `findCredentialsByEmail` is non-null
   (existing user unaffected).
6. **R-INV-15 — No cross-tenant IDOR on manage.** `GET /v1/invites` returns only the caller's
   tenant's invites; `POST /v1/invites/:id/revoke` against an id owned by another tenant returns a
   generic **404** and changes nothing. *Test:* create invite in tenant B; as admin of tenant A,
   list (B's invite absent) and revoke B's id (404, B's row unchanged).

### High

7. **R-INV-4 — Expiry enforced server-side.** `expires_at` is NOT NULL (default 7d); an accept after
   expiry returns 401 and does not consume. *Test:* advance the injected clock past `expires_at`;
   accept → 401, invite not consumed.
8. **R-INV-5 — Revoke kill-switch is immediate.** After revoke, any accept of that invite returns
   401; there is no check/consume window where a revoked invite still provisions (the `WHERE
   status='pending'` excludes it atomically). *Test:* revoke then accept → 401, no user created.
9. **R-INV-6 — No enumeration oracle on accept.** Every invalid accept (no such token, expired,
   revoked, email mismatch, lost race) returns the **same** generic `401 reject_no_valid_invite`
   body/status as `reject_no_provisioned_user`. *Test:* assert byte-identical error response across
   all five invalid cases.
10. **R-INV-11 — Token not leaked via URL on the accept page.** The accept route moves the token into
    a short-lived httpOnly cookie and strips it from the visible URL; the accept response sets
    `Referrer-Policy: no-referrer`; the token never appears in the onward redirect to Google. *Test:*
    assert post-accept URL/history carries no token; assert `Referrer-Policy` header; assert the
    Google authorize redirect contains no invite token.
11. **R-INV-12 — Token not leaked via logs or the create response sink.** The accept token reaches
    the control-plane in a request body (not a query string); access-log config omits query strings /
    the token param for `/invite/accept`; the plaintext secret and `token_hash` are on a never-log
    denylist; the one-time create response body is not logged. *Test:* log-capture over create +
    accept contains no plaintext token and no `token_hash`.
12. **R-INV-13 — No email header/template injection.** Recipient and any interpolated field reject
    CR/LF and C0 control characters; mail is composed via the provider SDK's structured params (no
    string-concatenated headers); the template auto-escapes; the only URL is server-built from
    `token + fixed base`. *Test:* address/field containing `\r\nBcc:` and `<script>` is rejected (or
    escaped) and produces no extra header / executable markup.
13. **R-INV-17 — Provisioning is atomic.** Consume + create-user + create-membership + linkFirst run
    in one transaction; an injected failure at any step rolls back the consume (invite stays
    `pending`) and leaves no orphan user/membership/identity. *Test:* fault-inject membership-create
    failure → invite still `pending`, zero new rows; fault-inject the R13 `linkFirst` conflict → 401,
    invite not consumed.
14. **R-INV-10 — Spray/abuse resistance.** The accept path is rate-limited (reuse the OIDC callback
    limiter) and rejects an unknown token **before** any Google/email call; `POST /v1/invites` is
    rate-limited; a per-tenant cap bounds outstanding `pending` invites. *Test:* assert 429 after
    threshold on accept and on create; assert zero outbound Google/email calls on an unknown-token
    accept; assert create beyond the cap is refused.

### Medium

15. **R-INV-9 — Audit events + log hygiene.** Create / revoke / invite-provisioned /
    reject-no-valid-invite each emit a structured audit record carrying tenant, actor/user id, hashed
    sub (where applicable), outcome, and timestamp — and **never** the raw token, full email, or raw
    sub. *Test:* one audit event per outcome; assert no raw token/email/sub in any record (sub/email
    appear only hashed, matching `hashProviderSub`).
16. **R-INV-14 — Email-send SSRF/abuse containment.** The provider endpoint/credentials come only
    from `EMAIL_PROVIDER` config (never request-derived); send targets only the invite's bound
    validated address; provider secrets never cross into the HTTP/auth layers; an email failure does
    not fail create. *Test:* no request field can redirect the send target; create with a failing /
    unconfigured provider still returns the link (no email sent).
17. **R-INV-18 — Forwarding resilience (derived).** A forwarded invite email cannot onboard a third
    party: covered by R-INV-1 (email mismatch), R-INV-3 (single-use), R-INV-4 (expiry). *Test:*
    forward scenario — different Google email → 401; reused after consume → 401.
18. **R-INV-20 — Tenant/returnTo from the invite, no open redirect.** The accept flow's tenant is
    read from the invite row server-side (no invitee-supplied tenant); any `returnTo` passes the
    existing same-origin relative-path allowlist. *Test:* invitee-supplied tenant param is ignored;
    `returnTo=//evil.com` (and `https://evil.com`, `/\evil.com`) falls back to default.

---

## 5. Constraints handed to the data + plan phases

These requirements pin specific data-model and API shapes; the data-architect and implementation
plan must encode them, not re-litigate them.

**Data model (the `invites` migration):**
- **Store only `token_hash` (`sha256`, NOT NULL, UNIQUE)** — never the plaintext secret. (R-INV-2)
- **`expires_at` NOT NULL** (default 7d) — there is no "never expires" invite. (R-INV-4)
- **`status` enum CHECK `in ('pending','consumed','revoked')`**, default `'pending'` — revoke is a
  status flip, not a delete, so the atomic consume and the audit trail both observe it. (R-INV-3/5/9)
- **`role` CHECK `in ('member','admin')`** — the granted role is a constrained column on the row,
  the single source of truth for the membership created at consume. (R-INV-8)
- **`tenant_id` NOT NULL + FORCE ROW LEVEL SECURITY**, consistent with other tenant tables — the
  basis for cross-tenant IDOR prevention. (R-INV-7/15)
- **Atomic consume as a conditional UPDATE** `WHERE id=$1 AND status='pending' AND expires_at>now()
  RETURNING …` — validity check and consume are one statement; provisioning shares its transaction.
  (R-INV-3/17)
- **Partial unique index** on `(tenant_id, email)` where `status='pending'` to bound at most one live
  invite per email (also caps the spray surface). (R-INV-10) — confirm with the per-tenant cap.

**API / behavior:**
- **Generic accept failure** — a single `401 reject_no_valid_invite` for all invalid cases; no
  "expired" vs "revoked" vs "no such invite" distinction to the invitee. (R-INV-6)
- **Plaintext token returned exactly once** in the create response; not stored, not logged, not in
  list output. (R-INV-2/12)
- **Accept token travels in a request body**, not a query string, past the browser; the visible
  accept URL is cleaned and carries `Referrer-Policy: no-referrer`. (R-INV-11/12)
- **Manage ops scope by session tenant claim**, never a body/path tenant; cross-tenant id → 404.
  (R-INV-15)
- **New audit outcomes** to add to `OAuthAuditOutcome` (`ports.ts:404`): `invite_provisioned` and
  `reject_no_valid_invite` (the latter replaces, in the invite branch, the standalone
  `reject_no_provisioned_user` for the no-invite case); plus admin-side `invite_created` /
  `invite_revoked` events (which may warrant a separate `InviteAuditEvent` rather than overloading
  `OAuthAuditEvent`). (R-INV-9)
- **Rate-limit** the accept path (reuse OIDC limiter) and `POST /v1/invites`; reject unknown tokens
  before any outbound Google/email call. (R-INV-10)

**Code-path constraint (the enforcement point):** the entire invite branch replaces ONLY the
`reject_no_provisioned_user` arm at `oidc-authenticator.ts:287-290` and runs **after** id_token
verification and **only** when `findCredentialsByEmail == null` AND there is no existing
`oauth_identity` for the sub — preserving the OAuth model's R1/R2/R3/R13 invariants and ensuring an
invite can never escalate or re-link an already-provisioned user. (R-INV-8)
