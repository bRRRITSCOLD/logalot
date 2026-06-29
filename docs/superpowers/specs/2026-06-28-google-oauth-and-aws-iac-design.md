# Spec — Google OAuth Sign-In + AWS IaC (cost-first PoC)

**Date:** 2026-06-28
**Status:** Approved (brainstorming gate passed)
**Goal owner:** user
**Delivery flow:** `/compainy:deliver` → feature-delivery. This spec is Phase 0 output. PLAN-ONLY engagement — produce spec → architecture/ADRs → data model → implementation plan → tracked GitHub issues, then STOP before dispatching the first implementer.

## Problem statement

logalot is a multi-tenant logging platform with email/password auth (control-plane: short JWT + rotating refresh, Postgres+RLS) and zero deployment infrastructure (local docker-compose only). Two coupled needs:

1. **Google OAuth sign-in** — let users authenticate with Google instead of (in addition to) a password.
2. **AWS deployment via IaC** — provision a reproducible, *cost-efficient* AWS stack so logalot runs in the cloud.

Both are proof-of-concept scope. Cost efficiency is a first-class non-functional requirement, not an afterthought.

## Outcomes

- A provisioned user can sign in via Google and land authenticated, with the same session semantics (JWT + rotating refresh) as the password path.
- Password auth continues to work unchanged; Google is additive.
- `terraform apply` stands up the full logalot stack on AWS at a target of **~$15–30/month**.
- An AWS Budgets alarm fires before spend exceeds the PoC ceiling.
- Real S3 in AWS unblocks wiring the deferred `cold_smoke_aws` CI job (gates #63 AC#3).

## Scope

### In scope

**Track A — Google OAuth**
- OIDC authorization-code flow, client_secret held server-side in control-plane.
- New OIDC `Authenticator` adapter in control-plane (the port ADR-0007 pre-built for SSO).
- `POST /auth/oidc/google/callback` endpoint: code exchange + `id_token` verification + email→user match + session mint.
- web: "Sign in with Google" button, redirect initiation, callback route, BFF forwarding of `code` to control-plane.
- New `oauth_identities` table (RLS, `UNIQUE(provider, provider_sub)`), migration `000017` (000016 already taken by retention-worker).
- Account linking: match Google `email` (require `email_verified=true`) to an existing provisioned user; store `google_sub` on first link; match on `sub` thereafter.
- **Tenant resolution (Phase-1 outcome, revised for multi-tenant membership):** "Sign in with Google" lives on the tenant-scoped login page; the server-side `state` carries the tenant hint (mirrors the password path's `tenantSlug`). Tenant is therefore *always known before lookup* — for first-link AND subsequent login. First link scopes the email match to that tenant; subsequent login arms RLS with the `state` tenant, then resolves by `(provider, provider_sub)` within that tenant. The "linked tenant == state tenant" check is **structural** (a row is only visible in its own tenant), so no global resolver is needed — the SECURITY DEFINER `resolve_oauth_identity_by_sub` is dropped.
- **Multi-tenant membership (user decision):** `UNIQUE(tenant_id, provider, provider_sub)` — one Google account links to one user *per tenant* and can sign into multiple tenants (via per-tenant invite). Account-takeover protection unchanged (email_verified=true + invite-only provisioning per tenant).
- **PKCE (S256)** enforced even for the confidential server-side client (defense-in-depth); `state`/`nonce`/`code_verifier` generated and stored in control-plane Redis (single-use, delete-on-consume), web BFF is a thin relay.

**Track B — AWS IaC**
- Terraform configuration provisioning: 1× t4g.small (Graviton/ARM) EC2 in a public subnet behind an Internet Gateway (no NAT), security group restricted to 443 (+ controlled admin access).
- EC2 user-data/cloud-init brings up the existing docker-compose stack: all 6 services + web + self-hosted Postgres/Redis/RabbitMQ containers.
- Caddy reverse proxy on the box terminating TLS via Let's Encrypt (required: Google OAuth needs an https redirect URI).
- Real AWS services (minimal): S3 (cold tier + Athena results, with lifecycle expiry), SSM Parameter Store (SecureString secrets), Route53 hosted zone (OAuth domain + ACME DNS), CloudWatch (minimal), AWS Budgets alarm.
- Wire `cold_smoke_aws` CI job against the real S3 bucket (follow-up within this epic; unblocks #63 AC#3).

### Out of scope

- **Self-serve tenant creation.** Signup is invite-only: a `tenant_admin` provisions the user first; Google login activates/links that existing account. Public self-serve signup + auto-tenant-provisioning is explicitly deferred.
- Other OAuth/OIDC providers (GitHub, Microsoft, generic SAML). The adapter is provider-shaped but only Google ships.
- High availability: no multi-AZ, no managed RDS/ElastiCache/Amazon MQ, no autoscaling. Single box, single AZ.
- Blue/green or zero-downtime deploy automation. Deploy is pull-image + restart on the box.
- Email-domain→tenant mapping.

## Key decisions (locked in brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Signup model | Invite-only / link-existing | Smallest, safest PoC; no tenant-provisioning complexity; matches "log in via Google" without public signup risk |
| AWS compute | Single t4g.small Graviton EC2 + docker-compose | Cheapest; proves cost discipline hardest; no managed-service bills |
| Backing stores | Self-hosted Postgres/Redis/RabbitMQ in containers; real S3 for cold | Avoids RDS/ElastiCache/MQ monthly cost |
| Deploy scope | Full stack (6 services + web) | Complete deployable system; natural home to wire cold_smoke_aws |
| IaC tool | Terraform | Most portable, team-neutral, largest ecosystem |
| Secrets | SSM Parameter Store SecureString | Free tier; cheaper than Secrets Manager ($0.40/secret/mo) |
| Networking | Public subnet + IGW, no NAT gateway | NAT GW ~$32/mo — larger than the whole compute budget |
| TLS | Caddy + Let's Encrypt on the box | Free auto-renewing certs; OAuth requires https redirect |

## Auth flow (Track A detail)

1. web login page → "Sign in with Google" → redirect to Google authorize endpoint (web holds client_id + redirect_uri only; includes `state` for CSRF + `nonce`).
2. Google authenticates user → redirects to web callback route with `code` + `state`.
3. web BFF validates `state`, POSTs `code` → control-plane `POST /auth/oidc/google/callback`.
4. control-plane (holds client_secret) exchanges `code` → tokens at Google's token endpoint; verifies `id_token` signature (Google JWKS), `iss`, `aud`, `exp`, `nonce`; requires `email_verified=true`.
5. Match `email` → existing user. **No match → reject (401)** — invite-only. Match → on first link insert `oauth_identities` row with `google_sub`; thereafter match by `(provider, provider_sub)`.
6. control-plane mints the same access JWT + rotating refresh token as the password path. Downstream (`TenantContext`, query-service JWT authenticator, kernel) unchanged.

## Security requirements (seed for Phase 1 threat model)

- CSRF protection via `state` parameter (signed/stored, single-use).
- Replay protection via `nonce` bound to `id_token`.
- Full `id_token` validation: signature against Google JWKS, `iss=accounts.google.com`/`https://accounts.google.com`, `aud=client_id`, `exp` not past.
- Reject `email_verified=false` to prevent account-takeover via unverified email match.
- Open-redirect prevention on the callback route (allowlist redirect targets).
- client_secret never reaches the browser; lives in SSM, read by control-plane only.
- Linking rule cannot cross tenants: email match is scoped within the existing user's tenant.

## Cost NFR (first-class — into architecture + ADR)

- Target: **~$15–30/month** total AWS spend for the PoC.
- Single AZ, single small Graviton (ARM) instance, gp3 EBS right-sized.
- No NAT gateway, no managed DB/cache/queue, no multi-AZ/HA, no load balancer (Caddy on the box).
- S3 lifecycle rules expire cold data + Athena results.
- AWS Budgets alarm as an enforced guardrail.
- Every infra ADR must state its cost tradeoff explicitly.
- Documented escape hatch (not built): Fargate + RDS + ElastiCache if the PoC graduates — YAGNI for now.

## Risks / watch-outs

- Single box = no HA; EBS snapshots are the only backup. Acceptable for PoC, stated in ADR.
- floci (local AWS emulator) ≠ real AWS for S3/Athena edge cases — real-AWS smoke test (`cold_smoke_aws`) is the gate.
- Google OAuth requires a real domain + https; Route53 + Caddy/ACME is on the critical path for an end-to-end demo.
- `gh issue create` requires explicit user approval — Phase 4 produces a DRAFT issue tree; do not file until greenlit.

## Open questions (resolve during architecture/data phases)

- Exact EC2 instance size (t4g.small vs t4g.medium) — depends on combined container memory footprint; size in Phase 1.
- Whether nonce/state are stored in Redis (already present) or signed cookies — decide in Phase 1.
- Migration ordering: `oauth_identities` = `000017` (000016 = retention-worker). Confirm no other in-flight schema work in Phase 2.
