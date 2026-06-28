# Logalot — Cold Tier Data Model

**Status:** Accepted (Phase 3) · **Date:** 2026-06-26 · **Owner:** data architect

Implements [ADR-0005](../adr/0005-cold-tier-and-retention.md). The cold tier is the **durable
long-term archive**, written by `processor` from **day 0** via a tee (not moved at 30 days). Hot
(`log_events` in Postgres) is the fast 30-day search window; cold (S3 Parquet + Athena) is the
cheap, query-on-demand history. Tenant isolation is structural: S3 key prefix + Glue partition +
a bound `tenant_id` predicate (the cold-tier layer of the four-layer model, ADR-0002 / `overview.md §6`).

Backend access goes through the `ColdArchive` port (write) and the cold path of the `LogStore`
port (read), so the Firehose→Parquet primary path and the direct-write fallback are
interchangeable (ADR-0005 / NFR `floci gaps`).

---

## 1. S3 key layout (tenant_id is the LEADING partition)

```
s3://logalot-cold/
  logs/
    tenant_id=<tenant-uuid>/
      dt=<YYYY-MM-DD>/
        hour=<HH>/
          <firehose-or-batch>-<seq>.parquet
```

- `tenant_id=<uuid>/` is the **first** path element — this is the cold isolation boundary. A query
  built for one tenant can only ever be pointed at that tenant's prefix (the prefix is templated
  from `TenantContext`, never user input).
- `dt=` (date) and `hour=` give time-based pruning that mirrors the hot daily partitions.
- Hive-style `key=value` path segments are what Glue/Athena read as partition columns directly.

---

## 2. Parquet record schema

Parquet is columnar + compressed → Athena scans only the columns a query needs, minimizing
pay-per-scan cost (NFR-4). The record mirrors `log_events` so hot and cold results union cleanly.

| Column | Parquet type | Maps to `log_events` |
|---|---|---|
| `tenant_id` | `string` (uuid) | `tenant_id` — also the partition key (redundant in-file for self-describing files) |
| `ts` | `bigint` (Unix epoch millis, UTC) | `ts` |
| `id` | `string` (uuid) | `id` |
| `service` | `string` | `service` |
| `level` | `string` | `level` (enum rendered as text) |
| `message` | `string` | `message` |
| `labels` | `string` (JSON-encoded) | `labels` — kept as a JSON string; Athena reads with `json_extract*` |
| `trace_id` | `string` (nullable) | `trace_id` |
| `span_id` | `string` (nullable) | `span_id` |
| `raw` | `string` (JSON-encoded) | `raw` |

Notes:
- No `search` tsvector in cold — full-text over history uses Athena `LIKE` / `regexp_like` over
  `message` (slower, acceptable for rare >30d queries; cold latency target is seconds–tens, not <2s).
- `labels`/`raw` are stored as JSON strings (not Parquet structs) so a fluid label schema does not
  force Parquet schema evolution per tenant; Athena's `json_extract_scalar` handles predicates.

---

## 3. Glue table + partitions

A single Glue **external table** over `s3://logalot-cold/logs/`, partitioned on
`(tenant_id, dt, hour)`:

```sql
CREATE EXTERNAL TABLE logalot_cold.log_events (
  tenant_id string,
  ts        bigint,      -- Unix epoch millis (UTC); stored as int64 in Parquet so Athena
                         -- compares without conversion. from_unixtime(ts/1000) to render.
  id        string,
  service   string,
  level     string,
  message   string,
  labels    string,
  trace_id  string,
  span_id   string,
  raw       string
)
PARTITIONED BY (tenant_id string, dt string, hour string)
STORED AS PARQUET
LOCATION 's3://logalot-cold/logs/'
TBLPROPERTIES ('parquet.compression'='SNAPPY');
```

Partition discovery: prefer **partition projection** (no per-write `ALTER TABLE ADD PARTITION`,
no `MSCK REPAIR` cost) so new `tenant_id=/dt=/hour=` prefixes are queryable immediately:

```sql
ALTER TABLE logalot_cold.log_events SET TBLPROPERTIES (
  'projection.enabled'             = 'true',
  'projection.tenant_id.type'      = 'injected',           -- value supplied by the query predicate
  'projection.dt.type'             = 'date',
  'projection.dt.format'           = 'yyyy-MM-dd',
  'projection.dt.range'            = '2026-01-01,NOW',
  'projection.dt.interval'         = '1', 'projection.dt.interval.unit' = 'DAYS',
  'projection.hour.type'           = 'integer',
  'projection.hour.range'          = '0,23', 'projection.hour.digits' = '2',
  'storage.location.template'      = 's3://logalot-cold/logs/tenant_id=${tenant_id}/dt=${dt}/hour=${hour}/'
);
```

`projection.tenant_id.type = injected` is deliberate: an injected projection column **requires**
an equality predicate on `tenant_id` in the query — Athena will not run a cold query that omits
it. That turns "always include the tenant predicate" from a convention into an engine-enforced
rule (defense in depth at the cold layer).

> **[RESOLVED 2026-06-27 — spikes #13/#14/#15, see [decision 016](spikes/016-floci-cold-tier-decision.md)]**
> floci fidelity was validated: **Glue cataloging + partition-projection DDL (incl. `injected`) + S3
> direct-write Parquet are faithful**; **Firehose→Parquet is NOT** (raw NDJSON, no conversion) so the
> cold write path is **processor-batched direct S3 Parquet + explicit Glue `CreatePartition`** (the former
> fallback, now chosen). floci **Athena** is a DuckDB sidecar that does not run the §4 templates or enforce
> `injected` projection, so **local cold-query validation uses Trino + HMS + MinIO** (Athena = managed
> Trino), and the tenant-predicate guard is enforced by the app-side SQL fitness function (§4 / NFR-6) plus
> a real-AWS CI smoke test. Cold search stays **feature-flagged off** until #17 lands these.

---

## 4. Athena query pattern (mandatory tenant predicate)

Every generated cold query binds `tenant_id` from `TenantContext` as a partition predicate. It is
**never** a caller-supplied value.

```sql
SELECT ts, id, service, level, message, labels
FROM logalot_cold.log_events
WHERE tenant_id = :ctx_tenant_id          -- bound from TenantContext (injected projection: REQUIRED)
  AND dt BETWEEN :from_date AND :to_date  -- prunes day partitions
  AND ( :q = '' OR regexp_like(message, :q) )                       -- optional FTS-ish
  AND ( :svc = '' OR service = :svc )                               -- optional structured filter
  AND ( :region = '' OR json_extract_scalar(labels, '$.region') = :region )
ORDER BY ts DESC
LIMIT :n;
```

- `tenant_id = :ctx_tenant_id` scans **only** `…/tenant_id=<ctx>/…` objects — another tenant's
  prefix is unreachable, and with injected projection the query cannot even compile without it.
- `dt BETWEEN` prunes date partitions so Athena scans only the days in range.
- **Fitness function (NFR-6):** assert every generated Athena SQL string contains the
  `tenant_id = <ctx>` predicate before execution; reject otherwise.

---

## 5. Hot → cold tiering & retention/expiry

### 5.1 Tee from day 0 (write path)

```
processor --(hot, transactional)--> Postgres log_events                       [system of record]
          --(cold, best-effort)----> batch-encode Parquet --> S3 PutObject     [durable archive, retried]
                                     --> Glue CreatePartition (tenant_id/dt/hour)
```

> **[AMENDED 2026-06-27, #13]** Cold delivery is **processor direct-write Parquet** (batched), not Firehose —
> floci's Firehose is non-faithful (decision 016). The hot insert is still the transactional write; the cold
> tee is still a retried best-effort side-effect that does not fail the message ack (NFR-2).

The hot insert is the transactional write; the cold tee is a retried side-effect whose failure
does **not** fail the message ack (NFR-2). Because cold is written from day 0, hot retention is a
cheap partition drop, not a risky migration.

### 5.2 Retention enforcement (two horizons)

| Tier | Policy source | Mechanism | Granularity |
|---|---|---|---|
| **Hot** | `retention_policies.hot_days` (default 30) | `app.drop_log_events_partitions_older_than(30)` drops daily partitions (O(1)) | Global horizon (partitions are time-only). Tenants wanting a *shorter* hot window: optional tenant-scoped `DELETE` off the hot path; else they rely on cold. |
| **Cold** | `retention_policies.cold_days` (default 365) | Scheduled job deletes expired `tenant_id=<id>/dt=<date>/…` S3 prefixes | **Per-tenant** — prefix delete is cheap and exact, so this is where true per-tenant retention lives. |

- Query routing (ADR-0003 / `overview.md §5.2`): a search within the hot window goes to Postgres;
  one spanning > `hot_days` goes to Athena; one straddling the boundary unions both, deduping on
  `(ts, id)`.
- Glacier / S3-lifecycle archive tiering is **deferred** — **[#15] confirmed appropriate**: floci accepts the
  lifecycle/storage-class APIs but enforces **no archive semantics** (RestoreObject is a stub), so local
  validation is not meaningful. Cold stays S3 standard; revisit when production cold-cost is material (apply
  `PutBucketLifecycleConfiguration` to real S3 then). Do not silently substitute localstack (ADR-0005, `nfr.md`).
