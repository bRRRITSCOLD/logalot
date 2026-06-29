# ADR-0009: AWS deployment topology — single Graviton EC2 + docker-compose

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** systems architect (+ security-architect on SG/trust boundary)
- **Related:** spec [2026-06-28-google-oauth-and-aws-iac-design](../superpowers/specs/2026-06-28-google-oauth-and-aws-iac-design.md) §Track B,
  ADR-0010 (IaC/secrets/TLS), ADR-0011 (cost NFR), ADR-0005 (cold tier → real S3), overview.md §7, NFR-4

## Context

logalot has **zero deployment infrastructure** — only a local `docker-compose` for the data plane. The PoC
needs a reproducible cloud deployment whose **cost is a first-class NFR (~$15–30/month total)**, not an
afterthought (spec §Cost NFR, ADR-0011). The system is **eight runtime containers** plus stateful backing
stores; it is **not** HA and does not need to be for a PoC (no multi-AZ, no autoscaling, no zero-downtime
deploy — spec §Out of scope). It does need: real S3 (to unblock the deferred `cold_smoke_aws` job that gates
#63 AC#3, ADR-0005), real HTTPS on a real domain (Google OAuth rejects non-HTTPS redirect URIs, ADR-0008),
and a hard spend guardrail.

The deployable footprint (from the repo): five Go units built from the single multi-stage Dockerfile
(`ingest-service`, `processor`, `query-service`, `alert-evaluator`, `retention-worker`), `control-plane`
(Node/Fastify), `web` (TanStack Start BFF), plus self-hosted `postgres`, `redis`, `rabbitmq`. The local-only
`mongodb` (reserved, ADR-0003) and `floci` (the AWS emulator) are **not** deployed — real AWS S3/Athena
replace floci in the cloud.

## Decision

Deploy the **entire stack onto one Graviton (ARM64) EC2 instance** running the existing `docker-compose`, in
a **public subnet behind an Internet Gateway with no NAT gateway**, fronted by **Caddy** on the box. Managed
AWS services are used only where self-hosting is impossible or pointless.

### Compute — one box, all containers
- A single EC2 instance (sizing in ADR-0011 / §Instance sizing below) runs an **AWS-specific compose** =
  the 5 Go services + `control-plane` + `web` + self-hosted `postgres`/`redis`/`rabbitmq` + **Caddy**.
- **Dropped from the AWS compose vs local:** `mongodb` (reserved, unused) and `floci` (replaced by real S3 +
  Athena). This is the key footprint reduction — the cloud box runs **fewer** containers than local dev.
- EC2 **user-data / cloud-init** installs Docker + compose, pulls images, reads config/secrets from SSM
  (ADR-0010), and `docker compose up -d`. Deploy = pull-image + restart on the box (no blue/green — out of
  scope).
- Images are built **ARM64** (Graviton) — the multi-stage Dockerfile and Node images must produce/pull
  `linux/arm64`. Flagged to lead-engineer: CI must build/publish arm64 images (or multi-arch).

### Networking — public subnet, IGW, no NAT
- One VPC, one public subnet, one Internet Gateway. The instance has a public IPv4 and reaches the internet
  (Google JWKS, ACME, ECR/registry, S3) **directly through the IGW** — **no NAT gateway**.
- **Security group, default-deny inbound**, opens only: **443** (Caddy/TLS) and **80** (ACME HTTP-01
  challenge + HTTP→HTTPS redirect) to the world; **22** (SSM Session Manager preferred; if SSH is kept, it is
  locked to an admin CIDR — "controlled admin access" per spec). Egress open. Trust-boundary detail and the
  admin-access decision are delegated to **security-architect**.

### Managed AWS services — minimal, real
- **S3** — cold-tier Parquet + Athena query results (ADR-0005), with **lifecycle expiry** rules so cold data
  and Athena results self-delete and storage stays bounded. This is the real-S3 target that unblocks
  `cold_smoke_aws`.
- **Athena + Glue** — cold query, pay-per-scan (already the ADR-0005 design); $0 at rest.
- Everything else (Postgres/Redis/RabbitMQ) is **self-hosted in containers** on the box — see rationale.

### Self-hosted vs managed — and what we deliberately did NOT use
- **No RDS / ElastiCache / Amazon MQ.** Managed Postgres/Redis/RabbitMQ would each add a standing monthly
  bill (the smallest RDS instance alone rivals the entire compute budget). Self-hosting in containers on the
  one box we already pay for is **$0 marginal**. Durability for the PoC is **EBS snapshots**, not managed
  multi-AZ. (Cost detail: ADR-0011.)
- **No NAT gateway.** A NAT GW is **~$32/mo + data processing** — larger than the entire compute budget. A
  public subnet + IGW gives the box outbound internet for free; the SG, not a private subnet, is the inbound
  control.
- **No Application/Network Load Balancer.** One box has nothing to balance; **Caddy on the instance**
  terminates TLS and reverse-proxies to `web`/`query-service`/`control-plane`. An ALB would add ~$16/mo +
  LCU for zero benefit at one instance.
- **No multi-AZ / autoscaling / blue-green.** Single AZ, single box (spec §Out of scope).

### Escape hatch (documented, NOT built)
If the PoC graduates to production load or needs HA, migrate to **Fargate (services) + RDS (Postgres) +
ElastiCache (Redis) + Amazon MQ or managed RabbitMQ + ALB**, multi-AZ. The ports-and-adapters boundaries and
the fact that every dependency is reached by config-driven endpoint mean this is a topology swap, not an app
rewrite. **YAGNI for now** — building it would multiply the bill 5–10× for a PoC that does not need it.

## Status

Accepted for the PoC. **Trigger to graduate** = sustained real traffic, an availability SLO, or a single-box
resource ceiling (CPU/mem/IO saturation, or recurring OOM-kills) — then execute the escape hatch.

## Consequences

### Positive
- Cheapest credible topology: one instance + S3 + a hosted zone, total in the **$15–30/mo** band (ADR-0011).
- One reproducible artifact (`terraform apply` + the existing compose) stands up the *whole* system, and is
  the natural home to finally wire `cold_smoke_aws` against real S3 (ADR-0005, #63 AC#3).
- Reuses the existing compose almost verbatim — minimal new surface, fast to stand up and tear down.

### Negative / costs
- **No HA.** Instance/AZ loss = full outage; recovery is re-provision + restore from EBS snapshot. Accepted
  for a PoC, stated loudly here.
- **Co-resident contention.** Postgres + RabbitMQ + Redis + 8 app containers share one box's CPU/RAM/IO; a
  noisy workload can starve neighbors. Mitigated by per-container memory limits and the sizing call (ADR-0011)
  — and bounded because PoC load is light.
- **floci ≠ real AWS.** Cloud S3/Athena edge cases differ from the local emulator; this is *why* the
  real-AWS `cold_smoke_aws` smoke test is the gate (ADR-0005, NFR §floci gaps).
- **ARM64 build requirement** on CI (Graviton). New build-matrix obligation for lead-engineer.

### Cost tradeoff
- Self-hosting the three backing stores instead of RDS+ElastiCache+MQ saves **roughly $40–80+/mo**; dropping
  the NAT gateway saves **~$32/mo**; dropping the ALB saves **~$16/mo**. These three avoidances are what make
  a ~$20/mo total feasible. Full line items: ADR-0011.

### Trigger to revisit
- **Resource saturation** (sustained high CPU/mem/IO, OOM-kills) → first resize the instance (ADR-0011), then
  if that is insufficient, execute the **escape hatch** above.
- **HA / SLO requirement** appears → escape hatch (multi-AZ managed services + ALB).
- **floci-vs-real-AWS divergence** surfaced by `cold_smoke_aws` → fix against real-S3 behavior (ADR-0005).

## Alternatives considered

| Option | Monthly cost | HA | Ops complexity | Footprint fit | Verdict |
|---|---|---|---|---|---|
| **Single Graviton EC2 + compose, public subnet, no NAT (chosen)** | ~$20 | None (single AZ) | Low | Whole stack on one box | **Chosen** — cheapest credible PoC |
| Fargate + RDS + ElastiCache + MQ + ALB, multi-AZ | ~$150–300+ | High | High | Managed per-service | Rejected for PoC (escape hatch) — 5–10× cost, HA unneeded |
| EC2 in private subnet + NAT gateway | +~$32/mo | None | Medium | Same | Rejected — NAT > whole compute budget; public subnet + SG suffices |
| EC2 + RDS/ElastiCache (managed stores, self-hosted apps) | ~$60–100 | Partial | Medium | Split | Rejected for PoC — managed-store bills blow the budget; self-host on the box |
| x86 (t3) instead of Graviton (t4g) | ~+20% compute | None | Low | Same | Rejected — Graviton is ~20% cheaper for equal perf; images are ours to build arm64 |
| Kubernetes (EKS/k3s) | EKS +$73/mo control plane | varies | High | Overkill | Rejected — pure ceremony for one box; compose is enough |
