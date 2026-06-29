# ADR-0011: Cost as a first-class NFR — AWS PoC budget and instance sizing

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** systems architect
- **Related:** spec [2026-06-28-google-oauth-and-aws-iac-design](../superpowers/specs/2026-06-28-google-oauth-and-aws-iac-design.md) §Cost NFR,
  ADR-0009 (topology), ADR-0010 (IaC/secrets/TLS), ADR-0005 (cold S3), NFR-4, nfr.md §NFR-4

## Context

Cost is a **first-class non-functional requirement** for this PoC, not an afterthought: the total AWS bill
must land at **~$15–30/month**. ADR-0009/0010 made the topology and tooling choices that keep it cheap; this
ADR makes cost **measurable and enforced** — an itemized estimate, a right-sized instance, an enforced
budget guardrail, and the explicit list of what was avoided and the dollars it saved. It also resolves the
spec's open question: **t4g.small (2 GiB) vs t4g.medium (4 GiB)**.

Pricing basis: **us-east-1, on-demand, 730 hrs/mo, mid-2026 list prices** (the team should re-confirm against
the current AWS price list at apply time; figures here are for budgeting, not billing).

## Decision

### Itemized monthly estimate (recommended config: t4g.small)

| Resource | Spec | Unit price | Monthly |
|---|---|---|---|
| EC2 compute | 1× **t4g.small** (2 vCPU, 2 GiB, Graviton), on-demand | $0.0168/hr | **$12.26** |
| Public IPv4 address | 1 in-use public IPv4 (AWS charges all public IPv4 since Feb 2024) | $0.005/hr | **$3.65** |
| EBS root volume | 30 GB **gp3** (3000 IOPS / 125 MB/s baseline, free) | $0.08/GB-mo | **$2.40** |
| S3 (cold + Athena results) | ~5 GB, lifecycle-expired; PUT/GET negligible | $0.023/GB-mo | **$0.12** |
| Athena | pay-per-scan; tiny PoC scans | $5/TB scanned | **~$0.20** |
| Route53 | 1 hosted zone (+ negligible queries) | $0.50/zone-mo | **$0.50** |
| Data transfer out | < 100 GB/mo (first 100 GB free) | $0.09/GB after | **~$1.00** |
| CloudWatch | few alarms + basic metrics (mostly free tier) | — | **~$0.50** |
| SSM Parameter Store | standard SecureString, default KMS key | — | **$0.00** |
| AWS Budgets | first 2 budgets free | — | **$0.00** |
| EBS snapshots | small incremental backups | $0.05/GB-mo | **~$0.20** |
| **Total (t4g.small)** | | | **≈ $21.03 / mo** |

Lands comfortably **mid-band** of the $15–30 target.

### Instance sizing — recommend t4g.small (2 GiB), resize-on-evidence to t4g.medium

The AWS box runs **fewer** containers than local dev: it **drops `mongodb` and `floci`** (ADR-0009). Rough
steady-state memory budget for the deployed set:

| Component | Est. RSS |
|---|---|
| Postgres 16 (tuned small: modest `shared_buffers`) | ~350 MB |
| RabbitMQ 3 | ~350 MB |
| Redis 7 | ~90 MB |
| 5 Go units (ingest, processor, query, alert-evaluator, retention-worker) | ~250 MB |
| control-plane (Node/Fastify) | ~180 MB |
| web (TanStack Start BFF, Node) | ~180 MB |
| Caddy | ~40 MB |
| OS + dockerd | ~350 MB |
| **Total** | **~1.79 GB** |

This **fits 2 GiB**, but with almost no headroom for page cache (which Postgres FTS benefits from) or load
spikes. **t4g.medium (4 GiB)** would be comfortable (~2 GiB free) but on-demand it costs **$24.53** instead of
$12.26, pushing the total to **~$33/mo — over the $30 ceiling once the IPv4 + EBS + DNS lines are added**.

**Decision: start on t4g.small** and treat the size as **reversible**. Mitigations make 2 GiB safe for PoC
load: (a) explicit per-container `mem_limit`s in the compose so no single container can balloon, (b) a small
**gp3 swap file** (~2 GB) as a burst safety net, (c) Postgres tuned for a small box. Because an EC2 resize is
a ~2-minute **stop → change instance type → start** (fully reversible, no data migration — EBS detaches and
reattaches), we choose the cheaper option now and upgrade **on evidence**, not on speculation (KISS +
reversible-over-irreversible).

### Budget guardrail (enforced)
- An **AWS Budget** at **$30/mo** with alert thresholds at **80% ($24)** and **100% ($30)**, plus a
  forecasted-overage alert, notifying the operator (SNS/email). Budgets is free for the first two budgets.
- S3 **lifecycle expiry** (ADR-0009/0005) keeps cold + Athena-results storage from growing unbounded — the
  one line item that could silently drift.

### What was deliberately avoided (and the $ saved)
| Avoided | Why | Approx. saved/mo |
|---|---|---|
| NAT gateway | Public subnet + IGW + SG suffices (ADR-0009) | **~$32** + data processing |
| RDS (managed Postgres) | Self-host on the box | **~$15–30+** |
| ElastiCache (managed Redis) | Self-host on the box | **~$12+** |
| Amazon MQ / managed RabbitMQ | Self-host on the box | **~$15+** |
| ALB / NLB | Caddy on the box (ADR-0009) | **~$16** + LCU |
| Secrets Manager | SSM SecureString (ADR-0010) | **~$3–4** |
| ACM + ALB for TLS | Caddy + Let's Encrypt (ADR-0010) | **~$16** (the ALB) |
| Multi-AZ / autoscaling / EKS | Single box, no HA (ADR-0009) | **$73+** (EKS control plane alone) |

Cumulative avoidance is well over **$100/mo** — the difference between a $20 PoC and a small production stack.

## Status

Accepted. **Recommended instance: t4g.small.** **Trigger to resize to t4g.medium** = a CloudWatch alarm on
sustained memory pressure (>90% for 15 min) **or** any `OOMKilled` container event. The resize is the first
escalation; the ADR-0009 escape hatch (managed services) is the second, for traffic/HA needs beyond a bigger
box.

## Consequences

### Positive
- A concrete, defensible **~$21/mo** estimate inside the $15–30 band, with every line justified and an
  **enforced** Budget alarm so spend cannot silently drift.
- The cheap-but-reversible sizing call avoids over-provisioning $12/mo of RAM the PoC may never use, while
  keeping a 2-minute upgrade path if it does.
- The avoidance table makes the cost discipline auditable and reusable as a checklist for future infra ADRs.

### Negative / costs
- t4g.small is **tight** (~200 MB headroom). Without the mem-limit + swap mitigations, real ingest load could
  OOM a container — hence the explicit resize trigger and CloudWatch alarm. This is a watch-out for
  lead-engineer (set the limits) and PM (the demo should not be load-tested on t4g.small without monitoring).
- The recent **public-IPv4 charge (~$3.65/mo)** is unavoidable and is what makes t4g.medium on-demand exceed
  the ceiling; it is outside our control and is why t4g.small is the budget-fitting choice.
- Estimates are list-price, single-region, on-demand; actual spend varies with region, traffic, and any
  future Savings Plan.

### Cost tradeoff
- This ADR **is** the cost tradeoff for the deployment. Net: ~$21/mo achieved, ~$100+/mo of managed-service
  and networking cost deliberately not incurred. A **1-yr Compute Savings Plan** on t4g (≈30–40% off compute)
  is a documented future lever (~$15/mo total) but is **not** committed now — YAGNI; do not lock a 1-yr term
  for a PoC whose lifetime is unknown.

### Trigger to revisit
- **Memory pressure / OOM** → resize to t4g.medium (total moves to ~$33; accept the slight overage for
  reliability, or apply a Savings Plan to claw it back under $30).
- **Budget alarm at 80%** fires → investigate the drifting line (usually S3/Athena scan or data transfer)
  before it hits 100%.
- **PoC graduates** (traffic/HA) → ADR-0009 escape hatch; this cost model is replaced by a production one.

## Alternatives considered

| Option | Total/mo | RAM headroom | OOM risk (PoC load) | Reversibility | Verdict |
|---|---|---|---|---|---|
| **t4g.small + mem-limits + swap (chosen)** | **~$21** | ~0.2 GB | Low-Med (mitigated) | Resize in ~2 min | **Chosen** — fits budget mid-band; cheap + reversible |
| t4g.medium on-demand | ~$33 | ~2.2 GB | Very low | Resize in ~2 min | Rejected (default) — exceeds $30 ceiling; kept as the resize target |
| t4g.medium + 1-yr Savings Plan | ~$20–24 | ~2.2 GB | Very low | Locks 1-yr term | Deferred — best if PoC proves long-lived; premature commitment now |
| t4g.micro (1 GiB) | ~$8 | negative | Certain OOM | n/a | Rejected — cannot hold the footprint |
