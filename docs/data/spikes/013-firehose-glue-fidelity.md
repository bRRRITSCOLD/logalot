# Spike #013 — floci Firehose→Parquet + Glue Cataloging Fidelity

**Issue:** [#13](https://github.com/bRRRITSCOLD/logalot/issues/13)
**Date:** 2026-06-27
**Author:** backend-engineer agent
**floci version:** 1.5.28 community edition
**Verdict:** CONFIRMED — floci Firehose cannot meet cold-tier requirements (raw NDJSON not
Parquet; literal `!{...}` placeholders not substituted) — root cause confirmed at source,
IAM-role variable controlled. Glue cataloging PASS.

---

## 1. Scope

Validates the cold-tier design (`docs/data/cold-tier.md §1–3`) against compose floci
(`floci/floci:1.5.28`, endpoint `http://localhost:4566`). Distinct claims tested:

| Claim | Source | Verdict |
|---|---|---|
| S3 key layout: `logs/tenant_id=.../dt=.../hour=.../...parquet` | §1 | **PASS** (direct write) |
| Firehose → S3 delivery happens at all | §1 / ADR-0005 | **PASS** (count-based flush) |
| Firehose writes the §1 partitioned key layout | §1 / ADR-0005 | **FAIL** (literal `!{...}`) |
| Parquet conversion in Firehose | §2 / ADR-0005 | **FAIL** (raw NDJSON; no Parquet path) |
| Glue external table DDL, schema, partition projection | §3 | **PASS** |
| Glue explicit partition registration (ADD PARTITION fallback) | §3 fallback | **PASS** |

> **Correction vs. the first draft of this spike.** An earlier pass concluded floci Firehose
> was a *no-op delivery stub*. That was an artifact of the test sending only 3 records: floci's
> flush is **count-based at 5 records with no time-based flush**, so a sub-threshold buffer never
> flushes. With the threshold met and the IAM-role variable controlled, floci **does deliver** —
> but as **raw NDJSON to a literal-placeholder key**, which is unusable for the cold tier. The
> recommendation (direct-write fallback) is unchanged and now rests on a confirmed root cause.

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

## 3. Evidence: Firehose → S3 delivery — FAIL (fidelity, not delivery)

### 3.1 What the committed test exercises

`tests/cold-tier-spike/cold_tier_spike_test.go` (sub-test `FirehoseDeliveryFidelity`) does the
following, in order — and these steps are exactly what the doc claims, so doc and test agree:

1. **Controls the IAM-role variable.** It creates an IAM role `firehose-delivery-role-spike`
   with a Firehose trust policy (`firehose.amazonaws.com` → `sts:AssumeRole`) and an inline S3
   write policy on the cold bucket, then points the delivery stream's `RoleARN` (and the
   schema-config `RoleARN`) at it. This removes the confound that a missing/unauthorized role
   could be the reason objects never appear.
2. **Configures the stream per the cold-tier design.** `ExtendedS3DestinationConfiguration` with
   the §1 dynamic-partition prefix
   `logs/tenant_id=!{partitionKeyFromQuery:tenant_id}/dt=!{timestamp:yyyy-MM-dd}/hour=!{timestamp:HH}/`
   and a `DataFormatConversionConfiguration` (HiveJsonSerDe in → ParquetSerDe/SNAPPY out)
   referencing the Glue table — i.e. the real §2 Parquet conversion.
3. **Asserts the `DescribeDeliveryStream` shape.** floci returns a plain
   `S3DestinationDescription` (not `ExtendedS3DestinationDescription`) — the extended/Parquet
   config is silently dropped on round-trip.
4. **Sends exactly 5 records** (`firehoseFlushCount`) to cross floci's hard-coded flush
   threshold (see §3.3), then inspects the delivered object and asserts the two cold-tier
   requirements floci violates: Parquet format, and substituted partition path.

### 3.2 Result

With the recognized role attached and the flush threshold met, floci **does deliver** — proving
this is **not** a stub and **not** an IAM-role problem. The delivered object fails both fidelity
checks:

- **Format — not Parquet.** The flushed object is raw NDJSON. First bytes are `{"te…` (JSON),
  not the Parquet magic `PAR1`. Verified:

  ```
  $ aws s3 cp s3://logalot-cold-spike/logs/flushproof/<uuid>.json - | head -c4 | xxd
  00000000: 7b22 7465                                {"te
  ```

  The flushed content is one JSON object per line (NDJSON), MIME `application/x-ndjson`.

- **Key layout — placeholders written literally.** Pointing the stream prefix at the §1
  dynamic-partition layout, the object landed at:

  ```
  s3://logalot-cold-spike/logs/tenant_id=!{partitionKeyFromQuery:tenant_id}/dt=!{timestamp:yyyy-MM-dd}/hour=!{timestamp:HH}/<uuid>.json
  ```

  The `!{...}` expressions are **not substituted** — they are part of the literal key. The data
  is therefore unreachable as Hive `tenant_id=/dt=/hour=` partitions; Glue/Athena cannot
  discover it.

- **Flush log confirms delivery happened** (count-based, to the configured bucket/prefix):

  ```
  INFO FirehoseService Flushed 5 records from stream flush-proof          to s3://logalot-cold-spike/logs/flushproof/<uuid>.json
  INFO FirehoseService Flushed 5 records from stream partition-fidelity   to s3://logalot-cold-spike/logs/tenant_id=!{partitionKeyFromQuery:tenant_id}/dt=!{timestamp:yyyy-MM-dd}/hour=!{timestamp:HH}/<uuid>.json
  ```

  (The earlier 3-record runs produced **no** `Flushed` line — sub-threshold, never flushed —
  which is what the first draft of this spike mistook for a stub.)

### 3.3 Root cause — confirmed at source

The behavior is fully explained by floci's own source, `FirehoseService.java` at tag `1.5.28`
(`github.com/floci-io/floci`, class `io.github.hectorvent.floci.services.firehose.FirehoseService`):

- **Count-based flush only; no time-based flush.** `putRecord` / `putRecordBatch` append to an
  in-memory buffer and flush *only* when `buffer.size() >= DEFAULT_FLUSH_COUNT` (`= 5`).
  `BufferingHints.IntervalInSeconds` is never read — there is no scheduled/background flush.
  This is why a sub-threshold buffer (≤4 records) never reaches S3.

- **Raw NDJSON, no Parquet path.** `flush()` concatenates each record's bytes with `\n` and calls
  `s3Service.putObject(bucket, key, body, "application/x-ndjson", …)`. There is **no**
  `DataFormatConversionConfiguration` / `ParquetSerDe` handling anywhere in the service — the
  config is parsed into the `S3Destination` model and ignored. So output is always NDJSON.

- **`resolvePrefix` only substitutes `{year}/{month}/{day}/{hour}`.** It does a literal
  `String.replace` for those four curly-brace tokens and nothing else. The real-Firehose
  `!{partitionKeyFromQuery:…}` and `!{timestamp:…}` expressions are not recognized, so they pass
  through verbatim into the S3 key.

- **`resolveBucket` honors the configured `BucketARN`** (parses the bucket name after the last
  `:`), so floci writes to the configured bucket/prefix — contradicting floci's own
  `docs/services/firehose.md`, which claims a hardcoded `floci-firehose-results` bucket. The
  source is authoritative; the docs are stale on this point.

floci's `docs/services/firehose.md` (@1.5.28) corroborates the shape independently:
> "Automatic Flush: Floci automatically flushes the buffer to S3 after **every 5 records**…
> Records are flushed as **raw NDJSON**…"

**Conclusion (CONFIRMED):** floci Firehose *delivers*, but cannot meet the cold-tier contract.
It emits **raw NDJSON, not Parquet** (the Glue Parquet serde cannot read it), and writes the
**dynamic-partition placeholders literally** (the data is not Hive-partitioned). The root cause
is confirmed at source, and the IAM-role variable is controlled in-test, so the FAIL is a
**fidelity** failure, not a non-delivery artifact.

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

- Runs the three fallback-path sub-tests (GlueCatalogFidelity, DirectS3WriteKeyLayout,
  GlueExplicitPartitionRegistration) — **expected PASS**.
- Runs `FirehoseDeliveryFidelity` — **expected FAIL** — which creates the recognized IAM
  delivery role (confound control), configures Parquet conversion + the §1 dynamic-partition
  prefix, sends exactly the 5-record flush threshold, then asserts the delivered object is
  Parquet (it is NDJSON → fail) and that the key has a substituted partition path (it is
  literal `!{...}` → fail). It also asserts the `DescribeDeliveryStream` shape.

Run against compose floci (`make up` first):

```
make cold-tier-spike
# or directly:
go test -tags=floci_spike -run TestColdTierFidelity -v -timeout 300s \
    ./tests/cold-tier-spike/...
```

Shape of the spike run (the FAIL is the FirehoseDeliveryFidelity assertions, by design):

```
--- PASS: TestColdTierFidelity/GlueCatalogFidelity
--- PASS: TestColdTierFidelity/DirectS3WriteKeyLayout
--- PASS: TestColdTierFidelity/GlueExplicitPartitionRegistration
--- FAIL: TestColdTierFidelity/FirehoseDeliveryFidelity
    FIDELITY GAP (format): cold-tier.md §2 requires Parquet ('PAR1'); floci delivered NDJSON. First bytes: "{\"tenant_id\":…"
    FIDELITY GAP (partitioning): floci wrote the dynamic-partition expressions LITERALLY:
      "logs/tenant_id=!{partitionKeyFromQuery:tenant_id}/dt=!{timestamp:yyyy-MM-dd}/hour=!{timestamp:HH}/<uuid>.json"
FAIL
```

---

## 6. Recommendation

**Switch `ColdArchive` to processor direct-write Parquet + explicit `ADD PARTITION`.**

Rationale:

1. **floci Firehose cannot produce the cold-tier artifact.** It is not a stub — it delivers —
   but it writes **raw NDJSON, not Parquet** (the Glue Parquet serde cannot read it) and writes
   the **dynamic-partition placeholders literally** (the data is not Hive-partitioned, so
   Glue/Athena cannot discover it). Root cause confirmed at source (§3.3). Relying on it would
   mean the cold tier is unqueryable in the dev/test environment.

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

- **Parquet *encoding* fidelity for our own writer**: floci's Firehose was shown NOT to produce
  Parquet, but this spike does not validate a Parquet *encoder* of our own. The direct-write
  adapter will need its own Parquet encoding + read-back test (issue #17).
- **Athena query execution**: out of scope (issue #14). The Glue table DDL is validated
  and ready; Athena query templates are deferred.
- **Partition projection query enforcement**: `projection.tenant_id.type = injected`
  is stored correctly by Glue, but whether Athena on floci enforces the mandatory
  tenant predicate at query time is an issue #14 concern.
