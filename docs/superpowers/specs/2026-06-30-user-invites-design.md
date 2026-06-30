# User Invites — Google-native, invite-only preserved

**Date:** 2026-06-30
**Status:** Spec (approved) — feeds architecture / threat-model / data / implementation-plan phases. No build yet.

## Problem statement

Today the only way a Google user can sign in to logalot is to be **hand-seeded** into the
`users` table first (the invite-only control: `oidc-authenticator.ts:285-290` —
`findCredentialsByEmail` → null → `401 reject_no_provisioned_user`). There is no UX to
onboard a user; every account requires a manual `INSERT`. This blocks real end-to-end use.

We want admins to **create and send invite links** so a new Google user can self-onboard,
**without weakening the invite-only security control** — an unsolicited Google account still
cannot get in. A valid, unexpired, unconsumed, email-matched invite is what authorizes
just-in-time (JIT) provisioning.

## Outcomes

- A tenant admin can create an invite scoped to `{email, role}` and receive a one-time
  shareable link; if an email provider is configured the link is also emailed.
- The invitee opens the link, completes Google sign-in, and is provisioned automatically on
  first sign-in — user + membership(role) created, invite consumed (single-use), Google
  identity linked.
- An unsolicited Google account (no valid invite) still gets the existing generic 401.
- Admins can list and revoke outstanding invites.

## Scope

### In scope
- `invites` persistence (new migration) with tenant RLS.
- Control-plane admin API: create / list / revoke invites (RBAC: `invite:create`,
  `invite:list`, `invite:revoke`).
- JIT provisioning path in the OIDC callback: valid invite → create user + membership +
  consume invite + link identity; replaces only the `reject_no_provisioned_user` branch.
- Optional `EmailSender` port + thin adapter (SES/SMTP), gated by `EMAIL_PROVIDER`; no-op/log
  fallback when unconfigured. Link is **always** returned regardless.
- Web: admin invites section (create/list/revoke/copy-link) + `/invite/accept` route + BFF
  relays.
- Audit events for create / revoke / invite-provisioned / reject.

### Out of scope (YAGNI)
- Bulk invites, invite resend / expiry-extension UI.
- Non-Google identity providers, SCIM / directory sync.
- Email provider beyond a thin SES/SMTP adapter + a local mail catcher for dev.
- Self-service tenant creation (invites are within an existing tenant).

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Delivery | **Both** — link always returned; email sent when `EMAIL_PROVIDER` configured, else link-only. |
| Invited role | **Admin picks role per invite** (`member` \| `admin`); acceptance creates the matching membership. |
| Token binding | **Email-bound** — Google `id_token` email (normalized) must equal the invite email. |
| Token storage | 256-bit CSPRNG secret, stored **hashed** (sha256, mirrors `api_keys` digest), shown once, never logged. |
| Lifecycle | Single-use + atomic consume; expiry default 7d (configurable); revocable. |
| Authz | Existing RBAC operations gated to tenant admins. |
| Scope of this delivery | Plan only — stop before build. |

## Flow

1. **Create.** Admin → `POST /v1/invites {email, role}`. Control-plane writes an `invites`
   row (`status='pending'`, `expires_at = now()+7d`, `token_hash = sha256(secret)`,
   `created_by`), returns `{ invite, inviteUrl }` with the plaintext token **once**. If
   `EMAIL_PROVIDER` set, also dispatch the email; failure to email does not fail the create
   (link already returned).
2. **Accept.** Invitee opens `/invite/accept?token=…` (web). The route stashes the token in
   a short-lived httpOnly cookie (same handshake-cookie pattern as OIDC state/tenant/returnTo)
   and starts the existing Google OIDC authorize, with the tenant taken from the invite — the
   invitee does not type a workspace.
3. **Provision.** Google callback → control-plane OIDC callback. At the current
   `reject_no_provisioned_user` branch (`oidc-authenticator.ts:285-290`): if `findCredentialsByEmail`
   is null, look up a valid invite (tenant + email == `id_token` email + `pending` + not
   expired). If found:
   - atomically consume (`UPDATE invites SET status='consumed', consumed_at=now() WHERE id=$1
     AND status='pending' RETURNING …`) — 0 rows ⇒ lost the race / already used ⇒ fall through
     to 401;
   - create the user (status `active`, `password_hash` = disabled placeholder — Google-only);
   - create membership(role);
   - `linkFirst` the `oauth_identity`.
   If no valid invite → unchanged `401 reject_no_provisioned_user`.
4. **Manage.** `GET /v1/invites` (list), `POST /v1/invites/:id/revoke` (revoke → `status='revoked'`).

## Security requirements (seed the threat model)

- **R-INV-1 Link interception** → email-bound: provision only when `id_token` email equals the
  invite email (case/Unicode-normalized). An intercepted link cannot onboard a different account.
- **R-INV-2 Token guessing** → 256-bit CSPRNG, stored hashed, constant-time compare.
- **R-INV-3 Replay / double-use** → single-use via atomic conditional UPDATE; concurrent accepts
  provision at most once.
- **R-INV-4 Stale invite** → expiry (default 7d), enforced server-side at accept.
- **R-INV-5 Admin kill-switch** → revoke invalidates immediately.
- **R-INV-6 Enumeration** → accept failures return the same generic error/401 as today
  (no "no such invite" vs "expired" distinction to the invitee).
- **R-INV-7 Authz** → `invite:create/list/revoke` gated to tenant admins via existing RBAC;
  invites are tenant-scoped under FORCE RLS.
- **R-INV-8 Privilege escalation** → an `admin`-role invite can only be created by a caller
  holding the appropriate operation; cross-tenant invite creation is impossible under RLS.
- **R-INV-9 Audit** → record `invite_created`, `invite_revoked`, `invite_provisioned`,
  `reject_no_valid_invite` (hashed sub/email, never raw token).
- **R-INV-10 Abuse / spray** → reuse OIDC route rate-limiting on accept; consider a per-tenant
  cap on outstanding invites (architecture to decide).

## Data (high level — data-architect to finalize)

New migration: `invites`
- `id uuid pk`, `tenant_id uuid not null fk tenants`, `email text not null` (normalized),
  `role text not null check (role in ('member','admin'))`, `token_hash text not null unique`,
  `status text not null default 'pending' check in ('pending','consumed','revoked')`,
  `expires_at timestamptz not null`, `created_by uuid fk users`, `consumed_at timestamptz`,
  `created_at/updated_at`.
- Indexes: unique `token_hash`; partial index on `(tenant_id, email)` where `status='pending'`;
  consider a unique constraint preventing >1 `pending` invite per `(tenant_id, email)`.
- FORCE ROW LEVEL SECURITY + tenant_id scoping, consistent with other tenant tables.
- Reuses `memberships` (migration 000004) for the granted role.

## Ports / adapters (hexagonal — matches existing control-plane structure)

- **Domain:** `Invite` entity + `InviteToken` value object.
- **Port:** `InviteRepository` — `create`, `findValidByTokenHash`, `consume` (atomic),
  `listByTenant`, `revoke`.
- **App:** `InviteService` (admin create/list/revoke). The OIDC authenticator gains an
  invite-provisioning collaborator used only in the previously-rejecting branch.
- **Port (optional):** `EmailSender` — SES/SMTP adapter when `EMAIL_PROVIDER` set; no-op/log
  adapter otherwise. The HTTP/auth layers never see provider secrets.

## Web

- Admin **Invites** section (mirrors `apps/web/src/features/admin/users-section.tsx`): create
  dialog `{email, role}`, list with status + expiry + copy-link, revoke button. Gated by the
  `invite:*` operations via the existing `can()` helper.
- `/invite/accept` route — reads the token, sets the handshake cookie, triggers Google sign-in
  (tenant from the invite, so no workspace prompt).
- BFF relays: `cpCreateInvite`, `cpListInvites`, `cpRevokeInvite` (provider-keyed control-plane
  paths, tenant in body — consistent with the OIDC relay fix in PR #139).

## Test design (seeds — test-design / lead-engineer to enumerate)

- Create: authz enforced (`invite:create` required); token returned once; row stores only the hash.
- Accept happy path: valid invite → user + membership(role) + identity link + invite consumed.
- Email mismatch → 401, invite **not** consumed.
- Expired invite → 401.
- Revoked invite → 401.
- Double-use / concurrent accept → provisioned exactly once (atomic consume).
- No invite at all → unchanged `reject_no_provisioned_user` 401 (control preserved).
- Email provider unconfigured → create still succeeds, link returned, no email sent.

## Open questions (for the architecture/data phases)

- One `pending` invite per `(tenant,email)` enforced, or allow multiple?
- Per-tenant outstanding-invite cap for abuse control?
- Revoke = status flip vs hard delete (audit retention favors status flip).
- Email adapter: SES vs SMTP first; local mail catcher (mailhog) for the dev loop.
