# ADR-0005: Cold tier and retention/tiering mechanism

- **Status:** Accepted — **amended 2026-06-27** (cold delivery path flipped Firehose → direct-write; see amendment below)
- **Date:** 2026-06-26 (amended 2026-06-27)
- **Deciders:** systems architect + data architect
- **Related:** spec §Storage & retention, overview.md §5.1/§6, ADR-0002, ADR-0003, NFR-4, NFR-6,
  **floci spikes #13/#14/#15 → [decision 016](../data/spikes/016-floci-cold-tier-decision.md)**

> **Amendment (2026-06-27) — floci fidelity validated.** Spikes #13/#14/#15 verified floci 1.5.28 against
> this ADR. Firehose→Parquet is **non-faithful** (raw NDJSON, no Parquet conversion, literal `!{...}`
> partition placeholders — confirmed in floci source). floci Athena is a real **DuckDB** sidecar whose
> dialect does not implement our `regexp_like`/`json_extract_scalar` templates and does not enforce
> `injected` projection. Glue cataloging, the projection DDL, and S3 direct-write Parquet are **faithful**.
> **The "direct-write" fallback below is therefore promoted to the chosen delivery path**, local cold-query
> validation moves to **Trino + Hive Metastore + MinIO** (Athena = managed Trino), and the proprietary
> injected-projection guard is enforced locally by the app-side **SQL fitness function** (NFR-6) plus a
> real-AWS CI smoke test. Kinesis is confirmed unused; Glacier/lifecycle deferral stands. The original
> decision text is retained below for the record; deltas are marked **[AMENDED]**. Full rationale and the
> re-scoped #17 work-list: [decision 016](../data/spikes/016-floci-cold-tier-decision.md).

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
- **Delivery:** ~~processor → **Firehose** delivery stream → **S3**, with Firehose buffering and **Parquet**
  conversion (columnar, compressed)~~. Behind a `ColdArchive` port. **[AMENDED 2026-06-27] processor →
  batched **direct S3 Parquet write** → explicit Glue `CreatePartition`** (Firehose dropped — verified
  non-faithful on floci, #13). Port contract unchanged; Firehose remains a swap-back option behind the port
  if a faithful implementation appears.
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

Accepted. Cold tier targets **S3 standard** only. ~~Firehose→Parquet is the primary path with a direct-write
fallback~~ **[AMENDED 2026-06-27] processor direct-write Parquet is the primary (and now only) path; Firehose
is rejected on floci-fidelity grounds (#13)**. Local cold-query validation uses **Trino + HMS + MinIO**, not
floci Athena (#14). Glacier/archive tiering is **deferred** (confirmed appropriate, #15). Cold search stays
**feature-flagged** until #17 lands direct-write + the SQL fitness function and the real-AWS smoke test passes.

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
- ~~**Firehose/Glue fidelity gap on floci:**~~ **[FIRED 2026-06-27, #13]** Firehose verified non-faithful →
  `ColdArchive` switched to **processor-batched direct S3 Parquet writes** + explicit `CreatePartition`.
  Glue cataloging itself is faithful. Re-evaluate only if a faithful floci Firehose ships.
- **Cold storage cost becomes material:** introduce S3 lifecycle-to-archive / Glacier tiering. **[#15]**
  floci enforces no Glacier archive semantics, so this is a real-S3-only change (standard
  `PutBucketLifecycleConfiguration`, no local validation); until then keep cold in S3 standard. Do **not**
  substitute localstack.
- ~~**Athena query-shape gaps:**~~ **[FIRED 2026-06-27, #14]** floci Athena (DuckDB sidecar) does not serve
  our `regexp_like`/`json_extract_scalar` templates or enforce `injected` projection → local cold-query
  validation moved to **Trino + HMS + MinIO**; the tenant-predicate guard is enforced by the app-side SQL
  fitness function (NFR-6) + a real-AWS CI smoke test. Cold search stays feature-flagged until #17 lands these.

## Alternatives considered

| Option | Cold cost | Query latency | tenant isolation | floci dependency | Verdict |
|---|---|---|---|---|---|
| Tee → Firehose → S3 Parquet + Athena | Low | Sec–tens of sec | S3 prefix + Glue part. | Firehose+Glue+Athena | ~~Chosen~~ **[AMENDED] Rejected** — Firehose non-faithful on floci (#13) |
| **Processor direct-write S3 Parquet + explicit `CreatePartition`** | Low | Same | Same | Glue+S3 (no Firehose) | **[AMENDED] Chosen** (#13); local query via Trino, not floci Athena (#14) |
| Move-at-30-days (no tee) | Low | Same | Same | Same | Rejected — risky migration, no day-0 durability |
| Keep everything hot (no cold) | High | Fast | n/a | none | Rejected — cost + unbounded hot growth |
| S3 + Glacier archive tiering | Lowest | High (restore) | Same | **unverified** | Deferred — floci Glacier unverified |

- **Direct-write** is the chosen fallback; it removes Firehose risk at the cost of implementing buffering/
  Parquet conversion ourselves.
- **Move-at-30-days** loses day-0 durability and introduces a migration job that can fail; tee is simpler
  and safer.
- **Glacier tiering** is the obvious cost optimization but depends on unverified floci capability, so it is
  explicitly deferred behind a trigger, not silently swapped for localstack.
