# ADR-0005: Cold tier and retention/tiering mechanism

- **Status:** Accepted
- **Date:** 2026-06-26
- **Deciders:** systems architect + data architect
- **Related:** spec §Storage & retention, overview.md §5.1/§6, ADR-0002, ADR-0003, NFR-4, NFR-6

## Context

The spec requires a **30-day hot tier** plus a **cold tier on cheap object storage (floci S3), queryable
via Athena**, with **per-tenant retention policy**. We need to decide (a) how data gets to cold, (b) the
cold layout (format + partitioning, including tenant isolation), and (c) how retention/tiering is enforced.
floci confirmed-supports S3, Firehose, Athena, Glue, SNS/SQS; **Glacier / S3 lifecycle-to-archive and
Kinesis are unverified** and must not be silently depended upon.

## Decision

- **Tee from day 0 (not move-at-30-days).** The `processor` writes every event to the hot store **and**
  streams it to the cold tier. Cold is the **durable long-term archive**; hot is the fast-search window.
  This gives durability independent of hot-store retention and means retention = simply dropping old hot
  partitions.
- **Delivery:** processor → **Firehose** delivery stream → **S3**, with Firehose buffering and **Parquet**
  conversion (columnar, compressed). Behind a `ColdArchive` port.
- **Layout / isolation:** `s3://logalot-cold/logs/tenant_id=<id>/dt=<YYYY-MM-DD>/hour=<HH>/*.parquet`.
  `tenant_id` is the **leading partition** — the cold-tier prefix-isolation layer of ADR-0002. A **Glue**
  table is partitioned on `tenant_id` + date; **Athena** queries are generated with the `tenant_id`
  partition predicate bound from `TenantContext`, so a cold query scans only the caller's prefix.
- **Query routing:** `query-service` routes a search to hot (Postgres) when the time range is within 30
  days, to **Athena** when it spans older data, and unions when it straddles the boundary (ADR-0003,
  overview.md §5.2).
- **Retention enforcement:** hot = drop time partitions older than the tenant's `RetentionPolicy.hotDays`
  (default 30). Cold = per-tenant `RetentionPolicy.coldDays` (default longer, e.g. 365); enforced by a
  scheduled job that deletes expired `tenant_id=.../dt=.../` prefixes. Retention policies live in the
  control plane (Identity & Access context).

## Status

Accepted. Cold tier targets **S3 standard** only. Firehose→Parquet is the primary path with a direct-write
fallback (below). Glacier/archive tiering is **deferred** (tracked floci gap).

## Consequences

### Positive
- Durable archive from day 0 → hot retention is a cheap partition drop, not a risky data migration.
- Parquet + partition pruning by tenant/date minimizes Athena bytes-scanned → low pay-per-query cold cost
  (NFR-4).
- Cold tenant isolation is structural (S3 prefix + Glue partition + bound predicate), consistent with the
  defense-in-depth model (ADR-0002, NFR-6).

### Negative / costs
- Tee doubles write paths in the processor (hot + cold); mitigated by Firehose batching off the hot path.
- Athena cold queries are higher-latency than hot search (seconds–tens of seconds); acceptable for
  historical (>30d) queries, which are rarer and not bound by the <2s hot target.
- Dependency on floci fidelity for Firehose/Glue/Athena (see fallback + tracked risks).

### Trigger to revisit
- **Firehose/Glue fidelity gap on floci:** if Firehose Parquet conversion or Glue cataloging is
  unreliable on floci, switch `ColdArchive` to **processor-batched direct S3 Parquet writes** (skip
  Firehose) — a localized adapter change.
- **Cold storage cost becomes material:** introduce S3 lifecycle-to-archive / Glacier tiering **only after**
  verifying floci support; until then keep cold in S3 standard. Do **not** substitute localstack.
- **Athena query-shape gaps:** if Athena on floci cannot serve our query templates, feature-flag cold
  search off and treat hot-only as the v1 search surface while we resolve it.

## Alternatives considered

| Option | Cold cost | Query latency | tenant isolation | floci dependency | Verdict |
|---|---|---|---|---|---|
| **Tee → Firehose → S3 Parquet + Athena (chosen)** | Low | Sec–tens of sec | S3 prefix + Glue part. | Firehose+Glue+Athena | **Chosen** |
| Processor direct-write S3 Parquet + Athena | Low | Same | Same | Athena only (less) | Fallback if Firehose flaky |
| Move-at-30-days (no tee) | Low | Same | Same | Same | Rejected — risky migration, no day-0 durability |
| Keep everything hot (no cold) | High | Fast | n/a | none | Rejected — cost + unbounded hot growth |
| S3 + Glacier archive tiering | Lowest | High (restore) | Same | **unverified** | Deferred — floci Glacier unverified |

- **Direct-write** is the chosen fallback; it removes Firehose risk at the cost of implementing buffering/
  Parquet conversion ourselves.
- **Move-at-30-days** loses day-0 durability and introduces a migration job that can fail; tee is simpler
  and safer.
- **Glacier tiering** is the obvious cost optimization but depends on unverified floci capability, so it is
  explicitly deferred behind a trigger, not silently swapped for localstack.
