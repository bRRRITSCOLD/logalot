# Spike #014 — floci Athena Query Template + Injected-Projection Fidelity

**Issue:** [#14](https://github.com/bRRRITSCOLD/logalot/issues/14)
**Date:** 2026-06-27
**Author:** backend-engineer agent
**floci version:** 1.5.28 community edition
**Blocked by:** Spike #013 (Firehose→Parquet + Glue cataloging)
**Verdict:** CONFIRMED — floci Athena is DuckDB v1.5.2 (not Trino/Presto). Glue catalog
bridge absent. All §4 query templates FAIL. Injected projection NOT enforced. Presto-dialect
functions (`regexp_like`, `json_extract_scalar`) absent. Real SQL execution confirmed (not a
stub). DuckDB direct-read of Parquet from floci S3 works. See §6 for recommendation.

---

## 1. Scope

Validates the cold-tier design (`docs/data/cold-tier.md §3–4`) against compose floci
(`floci/floci:1.5.28`, endpoint `http://localhost:4566`). Builds on spike #013:

| Claim | Source | Verdict |
|---|---|---|
| floci Athena executes real SQL (not a stub) | issue #14 | **PASS** |
| floci Athena engine identity | issue #14 | **PASS** (DuckDB v1.5.2) |
| Parquet seeding → DuckDB direct read from floci S3 | issue #14 | **PASS** |
| DuckDB `json_extract_string` on Parquet `labels` column | issue #14 | **PASS** |
| DuckDB `regexp_matches` on Parquet `message` column | issue #14 | **PASS** |
| Cross-tenant glob leak without tenant predicate | issue #14 | **PASS (concerning)** |
| cold-tier.md §4 template `SELECT … FROM logalot_cold.log_events` | §4 | **FAIL** |
| Presto/Trino `regexp_like` function | §4 | **FAIL** |
| Presto/Trino `json_extract_scalar` function | §4 | **FAIL** |
| Glue catalog bridge (DuckDB sees Glue tables) | §3 | **FAIL** |
| Injected projection enforcement (`tenant_id=` required) | §3 | **NOT ENFORCED** |
| `dt`/`hour` partition pruning via Glue projection | §3 | **NOT VERIFIABLE** |

---

## 2. Environment

```
floci version : 1.5.28 community
endpoint      : http://localhost:4566
AWS_REGION    : us-east-1
credentials   : test / test  (compose .env defaults)
DuckDB        : v1.5.2  (confirmed via SELECT version())
```

Stack started via `make up`. Health confirmed (all services `running`, including `athena`).

---

## 3. Evidence: Engine Identity — floci Athena is DuckDB v1.5.2

### 3.1 Confirmed via SELECT version()

```sql
SELECT version() AS duckdb_version
-- Result row: "v1.5.2"
```

**Observation:** The result `v1.5.2` is DuckDB's own version string. This is not Trino,
Presto, or any Athena-compatible engine.

### 3.2 Confirmed via error messages

Every failed query exposes the internal engine in its `StateChangeReason`:

```
floci-duck execute returned HTTP 500: {"status":"error","message":"..."}
```

The `floci-duck` prefix and the DuckDB-specific error format (`Catalog Error: Scalar Function
with name regexp_like does not exist! Did you mean "regexp_replace"?`) confirm DuckDB is the
sole execution engine.

### 3.3 Execution model

DuckDB wraps every user query in a `COPY (…) TO 's3://…'` before execution:

```
COPY (SELECT ... FROM logalot_cold.log_events WHERE ...) TO 's3://logalot-cold-athena-results/…'
```

This is visible in error messages. The result CSV/Parquet is written to the output S3 location
and then read back by the Athena SDK's `GetQueryResults`. Real SQL is executed (not a stub).

**IMPLICATION:** floci Athena is NOT Trino/Presto. AWS Athena IS managed Trino. The SQL
dialects are incompatible on the cold-tier.md §4 functions (`regexp_like`,
`json_extract_scalar`) and the Glue catalog integration.

---

## 4. Evidence: What WORKS on floci Athena (DuckDB)

### 4.1 Parquet seeding + direct DuckDB read from floci S3

Genuine Parquet files (written with `github.com/parquet-go/parquet-go v0.23.0`, SNAPPY
compression, exact cold-tier.md §2 schema) were seeded for two tenants:

```
s3://logalot-cold-athena-spike/logs/tenant_id=aaaaaaaa-…-000001/dt=2026-06-27/hour=14/batch-spike14-001.parquet  (3 rows: tenantAlpha)
s3://logalot-cold-athena-spike/logs/tenant_id=bbbbbbbb-…-000002/dt=2026-06-27/hour=14/batch-spike14-001.parquet  (2 rows: tenantBeta)
```

DuckDB's `read_parquet('s3://…')` syntax reads these files directly:

```sql
SELECT id, service, level, message
FROM read_parquet('s3://logalot-cold-athena-spike/logs/tenant_id=aaaaaaaa-…/dt=2026-06-27/hour=14/*.parquet')
ORDER BY id
-- Returns 3 rows: id-alpha-001/002/003, content correct.
```

```sql
SELECT id, service, level, message
FROM read_parquet('s3://logalot-cold-athena-spike/logs/tenant_id=bbbbbbbb-…/dt=2026-06-27/hour=14/*.parquet')
ORDER BY id
-- Returns 2 rows: id-beta-001/002, content correct.
```

**Verdict:** DuckDB reads real Parquet files from floci S3 and returns content-correct rows.
It is NOT a stub. Both row counts and field values match the seeded data.

### 4.2 DuckDB equivalents of the §4 Presto functions — WORK

| §4 function (Presto/Trino) | DuckDB equivalent | floci result |
|---|---|---|
| `json_extract_scalar(labels, '$.region')` | `json_extract_string(labels, '$.region')` | **PASS** |
| `regexp_like(message, 'order.*')` | `regexp_matches(message, 'order.*')` | **PASS** |

```sql
-- json_extract_string filter on Parquet labels (tenantAlpha, 2/3 rows have us-east-1)
SELECT id, json_extract_string(labels, '$.region') AS region
FROM read_parquet('s3://…/tenant_id=aaaaaaaa-…/*.parquet')
WHERE json_extract_string(labels, '$.region') = 'us-east-1'
-- Returns 2 rows: id-alpha-001, id-alpha-002 (eu-west-1 row excluded) ✓

-- regexp_matches filter on Parquet message (1/3 rows start with "order")
SELECT id, message
FROM read_parquet('s3://…/tenant_id=aaaaaaaa-…/*.parquet')
WHERE regexp_matches(message, 'order.*')
-- Returns 1 row: id-alpha-001 "order placed successfully" ✓
```

Both predicates execute correctly on real data from floci S3. The ONLY issue is the function
name — the §4 template uses Presto/Trino syntax, which DuckDB does not have.

### 4.3 Cross-tenant glob leak (correct-but-concerning observation)

```sql
SELECT tenant_id, id FROM read_parquet('s3://logalot-cold-athena-spike/logs/**/*.parquet')
ORDER BY tenant_id, id
-- Returns 5 rows: 3 tenantAlpha + 2 tenantBeta
```

Without a tenant-scoped path, DuckDB returns all tenants' data. This confirms:
1. DuckDB reads across all Parquet files when the path is a glob.
2. The injected partition projection (which on real AWS forces `tenant_id=` as a required
   predicate) is NOT present in DuckDB.
3. The **app-side SQL fitness function** (cold-tier.md §4 NFR-6 — assert every generated SQL
   contains `tenant_id = <ctx>` before execution) is the ONLY local backstop.

---

## 5. Evidence: What FAILS on floci Athena

### 5.1 Glue catalog bridge — ABSENT

```sql
-- Glue table logalot_cold_athena_spike.log_events was created via Glue CreateTable API
-- (same round-trip confirmed in spike #013). Querying it through Athena:

SELECT ts, id, service, level, message, labels
FROM logalot_cold_athena_spike.log_events
WHERE tenant_id = 'aaaaaaaa-…'
  AND dt BETWEEN '2026-06-27' AND '2026-06-27'
ORDER BY ts DESC LIMIT 100
```

**Result:** FAILED

```
floci-duck execute returned HTTP 500: {"status":"error","message":"Catalog Error: Table with
name \"logalot_cold_athena_spike.log_events\" does not exist because schema
\"logalot_cold_athena_spike\" does not exist.\n\nLINE 2: \t\t FROM
logalot_cold_athena_spike.log_events\n              ^"}
```

DuckDB has its own in-memory catalog. The Glue tables created via the Glue API are stored in
floci's Glue emulation — but that catalog is NOT bridged to DuckDB. DuckDB has no knowledge
of any Glue database or table. The error `schema "logalot_cold_athena_spike" does not exist`
is DuckDB's own "not in my catalog" error, not a partition or access error.

**Root cause:** floci provides Glue as a separate emulated service (confirmed in spike #013 —
round-trip of DDL + partition projection properties works). But DuckDB, used as the Athena
execution engine, does not load Glue metadata. Real AWS Athena IS backed by Glue; floci Athena
is not.

### 5.2 Presto/Trino functions — NOT in DuckDB

```sql
SELECT regexp_like('order placed', 'order.*') AS match_val
```

**Result:** FAILED

```
{"message":"Catalog Error: Scalar Function with name regexp_like does not exist!
Did you mean \"regexp_replace\"?"}
```

```sql
SELECT json_extract_scalar('{"region":"us-east-1"}', '$.region') AS region_val
```

**Result:** FAILED

```
{"message":"Catalog Error: Scalar Function with name json_extract_scalar does not exist!
Did you mean \"json_extract\"?"}
```

Both functions are Presto/Trino-specific. DuckDB uses `regexp_matches` and `json_extract_string`
respectively. Since the cold-tier.md §4 query template uses Presto/Trino syntax (as it must —
real Athena IS Trino), these queries cannot be validated against floci.

### 5.3 Injected projection — NOT enforced by floci

```sql
-- §4 template WITHOUT tenant_id= (the case injected projection must reject)
SELECT ts, id, service, level, message, labels
FROM logalot_cold_athena_spike.log_events
WHERE dt BETWEEN '2026-06-27' AND '2026-06-27'
ORDER BY ts DESC LIMIT 100
```

**Result:** FAILED — with the **same Glue bridge error** as the query WITH `tenant_id=`:

```
{"message":"Catalog Error: Table with name \"logalot_cold_athena_spike.log_events\" does not
exist because schema \"logalot_cold_athena_spike\" does not exist."}
```

**Key observation:** Both the query WITH `tenant_id=` and the query WITHOUT `tenant_id=` fail
with **identical errors** at the Glue bridge layer — before DuckDB evaluates any predicate.
DuckDB does not know what partition projection is. The `projection.tenant_id.type = injected`
TBLPROPERTY stored in Glue (confirmed round-trip in spike #013) has no effect on DuckDB.

**CONCLUSION:** The injected-projection defense-in-depth (`projection.tenant_id.type = injected`
forces a `tenant_id=` equality predicate in every cold query) CANNOT be validated against floci.
On real AWS Athena, omitting `tenant_id=` from a query against this table produces:

> `COLUMN_NOT_PROJECTED: Column tenant_id is declared as type INJECTED. An equality predicate
> on this column must be provided.`

This rejection happens at Athena query compile time, before any S3 scan. floci DuckDB does not
implement this constraint at any layer.

### 5.4 Partition pruning — NOT verifiable via Glue

Since the Glue table is not visible to DuckDB, there is no mechanism for DuckDB to evaluate the
`storage.location.template` or the `projection.dt.type = date` / `projection.hour.type = integer`
properties. Partition pruning via the Glue projection mechanism is not verifiable on floci.

DuckDB CAN prune partitions when given a literal path glob that is scoped to specific
`dt=`/`hour=` segments (e.g. `read_parquet('s3://…/dt=2026-06-27/hour=14/*.parquet')`), but
this is DuckDB path-scoped reading, not Glue partition projection pruning.

---

## 6. Reproducible Test

The spike is encoded as a committed Go integration test at
`tests/cold-tier-spike/athena_projection_spike_test.go` (build tag `floci_spike`). It:

- Seeds Parquet files for two tenants using `parquet-go/parquet-go v0.23.0`.
- Runs DuckDB-compatible queries and asserts content-correct results (PASS sub-tests).
- Runs the §4 template and Presto-function queries and documents the fidelity gaps (FAIL sub-tests).
- Makes the "NOT ENFORCED" verdict for injected projection explicit and unambiguous.

Run against compose floci (`make up` first):

```
make cold-tier-spike-athena
# or directly:
go test -tags=floci_spike -run TestAthenaProjectionFidelity -v -timeout 300s \
    ./tests/cold-tier-spike/...
```

Expected output (abridged):

```
--- PASS: TestAthenaProjectionFidelity/ParquetSeedAndDirectRead
    PASS: tenantAlpha Parquet read → 3 rows returned; content correct (real SQL execution, not a stub).
    PASS: tenantBeta Parquet read → 2 rows returned; content correct.
--- PASS: TestAthenaProjectionFidelity/EngineIdentity
    PASS: floci Athena engine = DuckDB "v1.5.2"
--- PASS: TestAthenaProjectionFidelity/DuckDBEquivalents
    PASS: json_extract_string(labels,'$.region')='us-east-1' → 2 rows (correct)
    PASS: regexp_matches(message,'order.*') → 1 row "order placed successfully" (correct)
--- PASS: TestAthenaProjectionFidelity/CrossTenantGlobLeak
    PASS (with caveat): glob query across all tenants returned 5 rows (tenantAlpha=3, tenantBeta=2).
--- FAIL: TestAthenaProjectionFidelity/PrestoFunction_RegexpLike
    FIDELITY GAP: cold-tier.md §4 uses regexp_like (Presto/Trino syntax) but floci Athena (DuckDB v1.5.2) does not have this function.
--- FAIL: TestAthenaProjectionFidelity/PrestoFunction_JsonExtractScalar
    FIDELITY GAP: cold-tier.md §4 uses json_extract_scalar (Presto/Trino syntax) but floci Athena (DuckDB v1.5.2) does not have this function.
--- FAIL: TestAthenaProjectionFidelity/GlueBridge_TemplateWithTenant
    FIDELITY GAP (Glue bridge): cold-tier.md §4 query template FAILS on floci. DuckDB catalog is independent of Glue.
--- FAIL: TestAthenaProjectionFidelity/GlueBridge_TemplateWithoutTenant
    FIDELITY GAP (injected projection NOT enforced): fails for WRONG reason (Glue bridge, not projection error).
--- FAIL: TestAthenaProjectionFidelity/InjectedProjectionEnforcement
    FIDELITY GAP (injected-projection enforcement ABSENT): local guard = app-side SQL fitness function only.
FAIL
```

---

## 7. Recommendation

### 7.1 Local cold-query validation: MinIO + Trino + Hive Metastore

floci Athena (DuckDB v1.5.2) cannot validate the cold-tier.md §4 query templates because:

1. Its SQL dialect is DuckDB, not Trino/Presto (no `regexp_like`, no `json_extract_scalar`).
2. It has no Glue catalog bridge (tables must be referenced via `read_parquet('s3://…')`,
   not via a named table in a schema).
3. It does not enforce partition projection constraints (the injected `tenant_id=` requirement).

**Recommended local validation stack for the §4 queries:**
- **MinIO** (S3-compatible, path-style, no localstack) for Parquet storage.
- **Trino** (the engine AWS Athena IS) for SQL execution with full Presto/Trino dialect.
- **Hive Metastore** (open-source; Trino reads it natively) for Glue-equivalent table/partition
  metadata.

This stack provides complete fidelity for:
- `SELECT … FROM <db>.<table> WHERE tenant_id=… AND dt BETWEEN …` (named table references)
- `regexp_like` and `json_extract_scalar` (Trino/Presto native functions)
- Partition pruning via the Hive partition metadata
- Parquet read with the §2 schema

**Note on injected projection:** Trino's Hive connector does NOT implement
`projection.tenant_id.type = injected` (it is an AWS Athena proprietary feature). The
injected-projection enforcement is deferred to a real-AWS CI smoke test (§7.2).

### 7.2 Injected-projection enforcement: real-AWS CI smoke test

`projection.tenant_id.type = injected` is an AWS-proprietary Athena feature. Its enforcement
(a query without `tenant_id=` is rejected at compile time) can only be validated against real
AWS Athena. Add a CI stage that:

1. Creates the Glue table with `projection.tenant_id.type = injected` in a real AWS account.
2. Runs a query WITHOUT `tenant_id=` and asserts `COLUMN_NOT_PROJECTED` error.
3. Runs a query WITH `tenant_id=` and asserts success.

This is the authoritative validation of the cold-tier §3 defense-in-depth.

### 7.3 App-side SQL fitness function (local enforced backstop)

Cold-tier.md §4 mandates the fitness function (NFR-6): **assert that every generated Athena SQL
string contains `tenant_id = <ctx>` before submission to Athena, and reject otherwise.** This
is the ONLY guard that is:
- Enforced in the local dev/test environment (DuckDB and Trino both pass the query through if
  the path includes the tenant; the tenant predicate makes the path scope the correct tenant).
- Under the application's control (not dependent on an AWS proprietary feature).
- Testable with unit tests (the fitness function can be verified with pure string assertions).

Implement the fitness function in the cold-query path of `LogStore` (the cold adapter) before
calling `Athena.StartQueryExecution`. Reject with an `InternalError` (not a 4xx — this is a
programming error, not a client error) if the generated SQL lacks the predicate.

### 7.4 Explicit ADD PARTITION fallback (confirmed PASS in spike #013)

The `ADD PARTITION` (explicit `CreatePartition`) path is the correct partition registration
mechanism for floci and for local Hive Metastore. Partition projection (`MSCK REPAIR`, auto-
discovery) is irrelevant on floci. The Glue `CreatePartition` API round-trip was confirmed
PASS in spike #013 and is the approach the direct-write processor adapter should use.

### 7.5 Impact on cold-tier feature flag (#17)

| Concern | Status | Action |
|---|---|---|
| Parquet encoding + floci S3 write | **PASS** (spike #14 ParquetSeedAndDirectRead) | Direct-write adapter can use parquet-go; floci S3 accepts it |
| Glue table DDL + partition projection properties round-trip | **PASS** (spike #013) | DDL is validated, no change needed |
| Athena §4 query template on floci | **FAIL** (Glue bridge absent) | Local query tests need MinIO + Trino |
| `regexp_like` / `json_extract_scalar` on floci | **FAIL** (wrong dialect) | Test against Trino only |
| Injected projection enforcement on floci | **NOT ENFORCED** | Defer to real-AWS CI + fitness function |
| Partition pruning on floci | **NOT VERIFIABLE** | Defer to Trino/real-AWS |

The cold-tier feature flag should remain OFF until:
1. The processor direct-write Parquet adapter is implemented (replaces Firehose — spike #013).
2. The app-side SQL fitness function is implemented (local guard for tenant isolation).
3. A Trino+MinIO+Hive compose target is available for query-template integration tests.

---

## 8. What this spike does NOT validate

- **Production Parquet schema evolution**: the §2 schema is stable, but adding new columns to
  the Parquet schema or changing types requires a Parquet schema migration strategy. Out of scope.
- **Athena query cost (pay-per-scan)**: the Parquet columnar + SNAPPY compression benefit
  (NFR-4) requires real AWS billing data to measure.
- **`dt`/`hour` partition pruning accuracy**: verifiable only on Trino (local) or real AWS
  Athena. floci cannot assess this.
- **`BETWEEN` date arithmetic in Trino vs. the §4 template**: needs Trino validation.
- **Hot→cold query union deduplication**: out of scope (covered by the cold-query feature flag
  implementation in issue #17).
