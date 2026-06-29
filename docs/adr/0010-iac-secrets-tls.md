# ADR-0010: IaC tooling, secrets management, and TLS

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** systems architect (+ security-architect on secrets/TLS trust boundary)
- **Related:** spec [2026-06-28-google-oauth-and-aws-iac-design](../superpowers/specs/2026-06-28-google-oauth-and-aws-iac-design.md) §Track B,
  ADR-0009 (topology), ADR-0011 (cost), ADR-0008 (OAuth needs HTTPS + client_secret), NFR-4, NFR-5

## Context

ADR-0009 picks the topology (one Graviton EC2 + compose). Three cross-cutting infra decisions remain: **how**
the topology is provisioned (IaC tool), **where** secrets live (client_secret, JWT keys, DB/Redis/RabbitMQ
credentials, the BFF cookie key), and **how** TLS is obtained (Google OAuth requires an HTTPS redirect URI,
ADR-0008; OAuth also needs a stable real domain). All three are constrained by the cost NFR (ADR-0011): the
default answer is the **free** option unless there is a load-bearing reason to pay.

## Decision

### IaC — Terraform
Provision all AWS resources (VPC, subnet, IGW, route table, SG, EC2 + user-data, EBS, S3 + lifecycle, Glue,
IAM instance profile, SSM parameters, Route53 zone+records, CloudWatch alarms, AWS Budget) with **Terraform**.
State is stored in **S3 with native state locking** (no separate DynamoDB lock table needed on modern
Terraform/OpenTofu). Terraform is team-neutral, portable across clouds, has the largest ecosystem, and keeps
the whole stack reproducible from `terraform apply` (an outcome the spec calls for).

### Secrets — SSM Parameter Store (SecureString)
- All secrets are **SSM Parameter Store `SecureString`** parameters (KMS-encrypted with the default
  `aws/ssm` key): `google_client_secret`, JWT signing key(s), refresh-token pepper, the web BFF
  cookie-seal key, and the self-hosted Postgres/Redis/RabbitMQ credentials.
- The EC2 instance reads them at boot (and on redeploy) via an **IAM instance profile** scoped to
  `ssm:GetParameter*` on the `/logalot/<env>/*` path only — **least privilege**, no static AWS keys on the
  box. The OAuth `client_secret` is read by `control-plane` only and never rendered to the browser (ADR-0008).
- **Standard-tier** parameters (no advanced-tier $0.05/param/mo) and the default KMS key keep this at **$0**.
  Chosen over **AWS Secrets Manager** specifically on cost: Secrets Manager is **$0.40/secret/mo** + API
  charges (~$3–4/mo for our ~8 secrets) and we do not need its rotation/cross-account features for a PoC.

### TLS — Caddy + Let's Encrypt (ACME) on the box
- **Caddy** runs as a container on the instance, terminating TLS and reverse-proxying to `web`,
  `query-service`, and `control-plane`. It obtains and **auto-renews** certificates from **Let's Encrypt**
  via ACME (HTTP-01 over port 80, or DNS-01 via Route53 if wildcard is wanted later). Certs are **free** and
  renew without operator action — no ACM (ACM certs cannot be exported to a non-ALB/CloudFront box anyway).
- This is the HTTPS endpoint Google OAuth requires for its redirect URI (ADR-0008).

### DNS — Route53 hosted zone
- A **Route53 hosted zone** holds the OAuth domain's records (A/AAAA → the instance's public IP/EIP) and any
  ACME DNS-01 records. Hosted zone = **$0.50/mo**; queries are effectively free at PoC volume. A real,
  stable domain is required for both Google's redirect URI and a renewable TLS cert.

## Status

Accepted. Terraform + S3-backed state; SSM SecureString secrets via least-privilege instance profile; Caddy +
Let's Encrypt for TLS; Route53 for DNS.

## Consequences

### Positive
- Whole stack is one reproducible `terraform apply`; tear-down is `terraform destroy` (clean cost-off switch).
- **$0** secrets and TLS: SSM standard tier + default KMS key + Let's Encrypt cost nothing beyond the $0.50
  hosted zone; no static credentials on the instance (instance-profile only).
- Caddy auto-renews certs — no expiry-driven outages, no manual cert ops.

### Negative / costs
- SSM Parameter Store has no built-in rotation (Secrets Manager does); PoC secrets are rotated manually /
  via Terraform. Acceptable at this scale; revisit if rotation cadence becomes a requirement.
- Terraform state in S3 is a single sensitive artifact (it can contain secret values); the state bucket must
  be private, encrypted, and versioned — a security-architect checklist item.
- Caddy on the box is a single TLS terminator with no failover (consistent with the single-box, no-HA
  decision of ADR-0009).

### Cost tradeoff
- **SSM over Secrets Manager:** saves **~$3–4/mo** (~$0.40/secret × ~8 + API calls).
- **Caddy/Let's Encrypt over ACM+ALB:** ACM certs are free but require an ALB (~$16/mo) to serve; Caddy on
  the box serves free certs with **$0** added — saves **~$16/mo**.
- **Route53:** **$0.50/mo** — the one unavoidable line item here, required for OAuth's real domain + ACME.

### Trigger to revisit
- Move to **Secrets Manager** if automatic rotation / cross-account secret sharing becomes a requirement.
- Move TLS to **ACM + ALB** only if/when the escape-hatch ALB is introduced (ADR-0009) — then ACM is free and
  Caddy's role shrinks.
- Switch ACME to **DNS-01** if a wildcard cert or closing port 80 is wanted.

## Alternatives considered

| Concern | Chosen | Alternative | Why chosen |
|---|---|---|---|
| IaC tool | Terraform (S3 state + native lock) | CloudFormation / CDK / Pulumi | Portable, team-neutral, largest ecosystem; spec-locked |
| Secrets store | SSM Parameter Store SecureString | AWS Secrets Manager | ~$3–4/mo cheaper; rotation not needed for PoC |
| Secret delivery | IAM instance profile (least-priv path scope) | Static AWS keys in user-data/.env | No long-lived keys on the box; auditable, revocable |
| TLS certs | Caddy + Let's Encrypt (auto-renew) | ACM (needs ALB) / manual certs | Free, auto-renewing, works without an ALB on a single box |
| DNS | Route53 hosted zone | External registrar DNS | Native ALIAS/ACME-DNS integration; $0.50/mo is trivial |
