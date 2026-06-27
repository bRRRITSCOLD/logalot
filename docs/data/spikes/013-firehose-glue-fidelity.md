# Spike #013 — floci Firehose→Parquet + Glue Cataloging Fidelity

**Issue:** [#13](https://github.com/bRRRITSCOLD/logalot/issues/13)
**Date:** 2026-06-27
**Author:** backend-engineer agent
**floci version:** 1.5.28 community edition
**Verdict:** PARTIAL — Glue cataloging PASS, Firehose→S3 delivery FAIL (stub)

---

## 1. Scope

Validates the cold-tier design (`docs/data/cold-tier.md §1–3`) against compose floci
(`floci/floci:1.5.28`, endpoint `http://localhost:4566`). Three distinct claims were tested:

| Claim | Source | Verdict |
|---|---|---|
| S3 key layout: `logs/tenant_id=.../dt=.../hour=.../...parquet` | §1 | **PASS** (direct write) |
| Firehose → S3 delivery (any payload) | §1 / ADR-0005 | **FAIL** (delivery stub) |
| Parquet conversion in Firehose | §2 / ADR-0005 | **FAIL** (never reached — no delivery) |
| Glue external table DDL, schema, partition projection | §3 | **PASS** |
| Glue explicit partition registration (ADD PARTITION fallback) | §3 fallback | **PASS** |

---

## 2. Environment

```
floci version : 1.5.28 community
endpoint      : http://localhost:4566
AWS_REGION    : us-east-1
credentials   : test / test  (compose .env defaults)
```

Stack started via `make up`. Health confirmed:

```json
{"version":"1.5.28","services":{"s3":"running","firehose":"running","glue":"running","athena":"running",...},"edition":"community"}
```

---

## 3. Evidence: Firehose → S3 delivery — FAIL

### 3.1 What was tested

A Firehose delivery stream was created targeting `s3://logalot-cold/logs/` with the
`ExtendedS3DestinationConfiguration` (including `DataFormatConversionConfiguration` with
Parquet/SNAPPY schema referencing the Glue table) and also a simplified form (no Parquet
conversion, plain JSON passthrough, 1-second / 1 MB buffer). Records were put via both
`PutRecord` and `PutRecordBatch`. Both forms were tested.

### 3.2 Result

Records were accepted with HTTP 200 and valid `RecordId` values. The delivery stream
reached `ACTIVE` status. However:

- **Zero objects appeared in S3** after the 1-second buffer interval elapsed.
- **Polling for 90 seconds** (90× the configured interval) produced no objects.
- The **floci container log** showed no flush, delivery, or S3-write event after
  accepting PutRecord / PutRecordBatch — the log terminates at the PutRecord action
  with no downstream S3 activity.

```
2026-06-27 21:32:12 INFO  FirehoseService Created Firehose delivery stream: logalot-cold-stream
2026-06-27 21:32:41 INFO  AwsJson11Controller firehose action: PutRecord
2026-06-27 21:32:53 INFO  AwsJson11Controller firehose action: PutRecordBatch
# — nothing further. No S3 write event. No flush. No error.
```

### 3.3 Diagnosis

floci 1.5.28 community edition implements the Firehose **API surface** (CreateDeliveryStream,
DescribeDeliveryStream, PutRecord, PutRecordBatch all return valid responses) but does NOT
implement the **delivery loop** that flushes buffered records to S3. The Firehose service in
the community edition is a partial stub: it accepts records and reports success but silently
discards them.

Evidence that this is a stub limitation, not a configuration error:
- The simplified form (no Parquet, plain JSON, 1-second buffer) also produced zero S3 objects.
- The `DescribeDeliveryStream` response showed `S3DestinationDescription` rather than
  `ExtendedS3DestinationDescription`, indicating floci did not fully round-trip the extended
  configuration — a secondary signal that the implementation is incomplete.
- The floci health endpoint reports `"firehose":"running"` — the service reports healthy
  while silently stubbing delivery. There is no error, no log warning, and no failure mode
  that would surface this to a caller at runtime.

**Conclusion:** floci's Firehose is a no-op delivery stub. The Parquet conversion layer
was never exercised (there was nothing to convert — delivery never ran). Claims about
Firehose→Parquet fidelity cannot be made because the delivery loop does not exist in
this edition.

---

## 4. Evidence: Glue cataloging — PASS

### 4.1 External table DDL

The `logalot_cold.log_events` external table was created with the exact DDL from
`cold-tier.md §3`: 10 data columns, Parquet serde, SNAPPY compression, partition keys
`(tenant_id, dt, hour)`, `EXTERNAL_TABLE` type. `GetTable` round-tripped all properties
without loss.

**Partition projection properties verified (round-trip pass):**

| Property | Expected | Observed |
|---|---|---|
| `projection.enabled` | `true` | `true` |
| `projection.tenant_id.type` | `injected` | `injected` |
| `projection.dt.type` | `date` | `date` |
| `projection.dt.format` | `yyyy-MM-dd` | `yyyy-MM-dd` |
| `projection.dt.range` | `2026-01-01,NOW` | `2026-01-01,NOW` |
| `projection.dt.interval` | `1` | `1` |
| `projection.dt.interval.unit` | `DAYS` | `DAYS` |
| `projection.hour.type` | `integer` | `integer` |
| `projection.hour.range` | `0,23` | `0,23` |
| `projection.hour.digits` | `2` | `2` |
| `storage.location.template` | `s3://…/tenant_id=${tenant_id}/dt=${dt}/hour=${hour}/` | matches |

The `projection.tenant_id.type = injected` property — the key defense-in-depth constraint
that makes `tenant_id` a required query predicate — was stored and retrieved correctly.

### 4.2 S3 key layout (direct write)

Direct `PutObject` to `s3://logalot-cold/logs/tenant_id=<uuid>/dt=2026-06-27/hour=21/…`
succeeded. `GetObject` round-tripped the payload. `ListObjectsV2` returned the object at
the correct key. The Hive-style path structure from `cold-tier.md §1` is fully supported
by floci's S3.

### 4.3 Explicit partition registration (ADD PARTITION)

`CreatePartition` for `[tenant_id=a0000000-0000-0000-0000-000000000001, dt=2026-06-27, hour=21]`
pointing to the correct S3 prefix was accepted and returned by `GetPartition` with all fields
intact (values, storage descriptor, location, serde). The explicit `ADD PARTITION` fallback
path works end-to-end in floci.

---

## 5. Reproducible test

The spike is encoded as a committed Go integration test at
`tests/cold-tier-spike/cold_tier_spike_test.go` (build tag `floci_spike`). It:

- Runs all three sub-tests (GlueCatalogFidelity, DirectS3WriteKeyLayout,
  GlueExplicitPartitionRegistration) — **expected PASS**.
- Runs FirehoseS3Delivery — **expected FAIL** with an explicit fatal message documenting
  the trigger.

Run against compose floci (`make up` first):

```
make cold-tier-spike
# or directly:
go test -tags=floci_spike -run TestColdTierFidelity -v -timeout 300s \
    ./tests/cold-tier-spike/...
```

Actual output from the spike run:

```
--- PASS: TestColdTierFidelity/GlueCatalogFidelity (0.00s)
--- PASS: TestColdTierFidelity/DirectS3WriteKeyLayout (0.00s)
--- PASS: TestColdTierFidelity/GlueExplicitPartitionRegistration (0.00s)
--- FAIL: TestColdTierFidelity/FirehoseS3Delivery (92.09s)
FAIL
```

---

## 6. Recommendation

**Switch `ColdArchive` to processor direct-write Parquet + explicit `ADD PARTITION`.**

Rationale:

1. **Firehose→S3 delivery is a confirmed stub** in floci 1.5.28 community. Using it
   would mean cold-tier writes silently disappear in the dev/test environment with no
   observable failure, making the cold tier untestable locally.

2. **The fallback path has confirmed floci support**: S3 PutObject with Hive-style keys
   works, Glue `CreatePartition` works, and the Glue schema + projection properties
   round-trip correctly. The fallback is the only path that is actually testable end-to-end
   in this environment.

3. **`ColdArchive` port boundary is unchanged** — the adapter change is localized:
   - Remove the Firehose SDK dependency from `processor`.
   - Add a Parquet encoder (e.g. `github.com/apache/arrow/go/v18/parquet`) to batch
     events and write directly to S3 under the designed key layout.
   - On each batch flush, call `glue.CreatePartition` for the written partition (idempotent).
   - The Glue table still uses partition projection; the explicit `CreatePartition` calls
     keep the catalog consistent when projection is not used as the sole discovery mechanism.

4. **No production divergence**: AWS real Firehose with `DataFormatConversionConfiguration`
   is the architecturally "correct" path, and the port contract remains the same. If floci
   ever gains Firehose delivery support, the adapter could switch back to Firehose with no
   domain model change. The swap is purely an infrastructure adapter.

**What this means for issue #17 (cold-tier feature flag):**

The cold-tier feature flag should remain OFF until the direct-write processor adapter is
implemented. Once it is, the Glue table DDL (`docs/data/cold-tier.md §3`) is already
validated against floci and requires no changes. The Athena query path (issue #14) is
unblocked by this decision — it runs against the Glue table regardless of how data was
written.

---

## 7. What this spike does NOT validate

- **Parquet encoding fidelity**: not exercised because Firehose delivery never ran.
  The direct-write adapter will need its own Parquet encoding test (issue #17).
- **Athena query execution**: out of scope (issue #14). The Glue table DDL is validated
  and ready; Athena query templates are deferred.
- **Partition projection query enforcement**: `projection.tenant_id.type = injected`
  is stored correctly by Glue, but whether Athena on floci enforces the mandatory
  tenant predicate at query time is an issue #14 concern.
