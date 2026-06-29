# IaC Security Controls Review — T22

- **Status:** Verified
- **Date:** 2026-06-29
- **Author:** security-architect
- **Issue:** #109
- **Epic:** #87
- **Refs:** ADR-0009, ADR-0010, R8, R16, D3

## Scope

Review-only over T16 (SG/network), T17 (compute/IAM), T18 (data/managed services).
Asserts that threat-model IaC controls landed correctly.

> **Out of scope:** R17 (multi-tenant membership isolation) is an APP-LAYER
> structural requirement verified by T04/T10/T12/T19, NOT an IaC gate.

---

## Acceptance-criteria checklist

### SG-1 — Port 22 NOT open to world by default (D3)

- **File:** `infra/aws/security.tf`
- **Finding:** Port 22 is wrapped in a `dynamic "ingress"` block gated on
  `var.admin_cidr != ""`. The variable defaults to `""`, so no port-22 ingress
  rule exists in the default configuration. Only 443 and 80 are statically open.
- **Assertion:** `scripts/tf-iac-policy-assert.sh` assertion SG-1 passes.
- [x] **PASS**

### SG-2 / SG-3 — HTTPS (443) and HTTP/ACME (80) open to 0.0.0.0/0

- **File:** `infra/aws/security.tf`
- **Finding:** Static `ingress` blocks for ports 443 and 80 both specify
  `cidr_blocks = ["0.0.0.0/0"]`, enabling Caddy TLS termination and ACME
  HTTP-01 challenge / HTTP→HTTPS redirect.
- **Assertion:** `scripts/tf-iac-policy-assert.sh` assertions SG-2 and SG-3 pass.
- [x] **PASS**

### IAM-1 / IAM-2 / IAM-3 — SSM read scoped to `/logalot/<env>/*`, not `ssm:*` (R8)

- **File:** `infra/aws/ssm.tf`
- **Finding:**
  - Policy document `ssm_read` lists only
    `ssm:GetParameter`, `ssm:GetParameters`, `ssm:GetParametersByPath`
    (explicit allow-list, not `ssm:*`).
  - Resource ARN is
    `arn:aws:ssm:<region>:<account>:parameter/logalot/<env>/*` —
    never `"*"` or an unscoped wildcard.
  - `kms:Decrypt` is scoped to `data.aws_kms_alias.ssm.target_key_arn`
    (actual key ARN, not the alias, which IAM does not resolve in Resource).
- **Assertion:** `scripts/tf-iac-policy-assert.sh` assertions IAM-1, IAM-2, IAM-3 pass.
- [x] **PASS**

### STATE-1 / STATE-2 / STATE-3 / STATE-4 — Terraform state bucket private + encrypted + versioned (ADR-0010)

- **Files:** `infra/aws/bootstrap/main.tf`, `infra/aws/backend.tf`
- **Finding:**
  - `aws_s3_bucket_versioning.tf_state` → `status = "Enabled"` (STATE-1).
  - `aws_s3_bucket_server_side_encryption_configuration.tf_state` →
    `sse_algorithm = "AES256"` (STATE-2).
  - `aws_s3_bucket_public_access_block.tf_state` →
    `block_public_acls = block_public_policy = ignore_public_acls =
    restrict_public_buckets = true` (STATE-3).
  - `backend.tf` → `encrypt = true` (STATE-4).
  - Bucket policy denies non-TLS uploads and unencrypted `PutObject`
    (defence-in-depth).
- **Assertion:** `scripts/tf-iac-policy-assert.sh` assertions STATE-1..4 pass.
- [x] **PASS**

### TLS-1 / TLS-2 / TLS-3 — Caddy enforces HTTPS + HSTS (R16)

- **File:** `infra/aws/Caddyfile`
- **Finding:**
  - Caddy automatically redirects HTTP to HTTPS (built-in default; no explicit
    rule needed — port 80 is used only for ACME HTTP-01 and then redirects).
  - `Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"` —
    2-year max-age, preload-eligible (TLS-1).
  - `X-Content-Type-Options "nosniff"` — MIME-type sniffing prevention (TLS-2).
  - `X-Frame-Options "DENY"` — clickjacking protection (TLS-3).
  - `Referrer-Policy "strict-origin-when-cross-origin"` and `-Server`
    (server header stripped) are additional hardening wins.
- **Assertion:** `scripts/tf-iac-policy-assert.sh` assertions TLS-1, TLS-2, TLS-3 pass.
- [x] **PASS**

### COOKIE-1 / COOKIE-2 — Cookies `Secure` in non-dev (R16)

- **File:** `apps/web/src/server/session.ts`
- **Finding:**
  - `sessionCookieSecure()` defaults `true` (fail-safe). It opts out only when
    `NODE_ENV === 'development'` and `COOKIE_SECURE` is not explicitly set —
    so production, staging, and any environment that does not set `NODE_ENV`
    all receive `Secure` cookies. An explicit `COOKIE_SECURE=true` env-var
    overrides even `NODE_ENV=development`.
  - `sessionCookieAttributes()` always sets `httpOnly: true` and `sameSite: 'lax'`.
  - `serializeSessionCookie()` (used by the SSE proxy's raw `Set-Cookie` path)
    derives from the same function — single source of truth, no silent divergence.
- **Assertion:** `scripts/tf-iac-policy-assert.sh` assertions COOKIE-1, COOKIE-2 pass.
- **Unit tests:** `apps/web/src/server/session.test.ts` (cookie policy suite).
- [x] **PASS**

---

## Automated assertion

All 15 assertions can be verified without AWS credentials:

```bash
bash scripts/tf-iac-policy-assert.sh
# Results: 15 passed, 0 failed
```

The script is intentionally textual (no Terraform plan required) so it can run
in CI without AWS access.  It covers SG (D3), IAM (R8), state (ADR-0010),
TLS / HSTS (R16), and cookie Secure flag (R16).

---

## Residual risks and notes

| ID | Note |
|----|------|
| N1 | `var.admin_cidr` being set to a non-empty value re-opens SSH. Operators MUST leave it empty in production; SSM Session Manager is the approved admin path (ADR-0009). |
| N2 | SSE-S3 (AES-256) is used for state and data buckets at PoC scale. Upgrade to SSE-KMS with a CMK for stricter key-access auditing before promoting to production. |
| N3 | HSTS preload registration (chromium preload list) is a manual step performed once the domain is stable. The header is correct; the submission is an ops task. |
| N4 | `COOKIE_SECURE=false` explicitly disables the Secure flag. This override MUST NOT be set in any non-local environment. |
