# Cold-Tier floci Fidelity — Consolidated Decision (spikes #13/#14/#15)

**Status:** Accepted · **Date:** 2026-06-27 · **Owner:** delivery (orchestrated)
**Supersedes the "tracked floci risk" caveats in** [`docs/data/cold-tier.md`](../cold-tier.md) **and the Firehose-chosen
decision in** [ADR-0005](../../adr/0005-cold-tier-and-retention.md). **Gates** issue #17 (cold tier).

This consolidates the three floci-risk validation spikes into a single decision that re-scopes #17.
All three ran against compose **floci 1.5.28** (NOT localstack). Evidence: spike docs 013/014/015 +
their committed `tests/cold-tier-spike/` integration tests (build tag `floci_spike`).

---

## TL;DR

| Question | Verdict | Source |
|---|---|---|
| floci Firehose → Parquet conversion | **FAIL — non-faithful.** Delivers raw NDJSON, no Parquet, writes `!{...}` partition expressions literally. Root cause confirmed in floci `FirehoseService.java@1.5.28`; IAM-role confound controlled in-test. | #13 |
| floci Glue catalog + projection DDL | **PASS** — table + all 12 projection props (incl. `projection.tenant_id.type=injected`) + explicit `CreatePartition` round-trip faithfully. | #13 |
| S3 direct-write Parquet (Hive key layout) | **PASS** | #13 |
| floci Athena executes our §4 templates | **FAIL (dialect).** floci Athena is a **real DuckDB sidecar** (not a stub — content-correct results), but DuckDB ≠ Presto/Trino: `regexp_like` / `json_extract_scalar` **do not exist in DuckDB**; named Glue-table refs are not bridged. | #14 |
| floci enforces `injected` projection (refuse query without tenant predicate) | **FAIL — not enforced.** DuckDB has no concept of Athena table properties. (AWS-proprietary; no OSS emulator reproduces it **except Trino**.) | #14 + research |
| Kinesis Data Streams used anywhere | **No — CONFIRMED UNUSED** (0 build-path matches; broker is RabbitMQ). | #15 |
| floci Glacier / S3-lifecycle archive | API round-trips but **no archive semantics enforced** (RestoreObject is a stub) → local validation not meaningful; **deferral confirmed**. | #15 |

---

## Decision (re-scopes #17)

1. **Drop Firehose. Cold write = processor direct-write Parquet + explicit Glue `CreatePartition`.**
   This is the ADR-0005 fallback, now promoted to the chosen path on verified evidence. The `ColdArchive`
   port contract is unchanged (infra-adapter swap only); if floci ever ships faithful Firehose delivery the
   adapter can switch back without domain changes. S3 key layout (cold-tier.md §1) and the Glue
   table + projection DDL (§3) are **confirmed correct — no changes there**.

2. **Local cold-query validation does NOT use floci Athena. Use Trino + Hive Metastore + MinIO.**
   Athena Engine v3 *is* a managed Trino fork, so our exact §4 SQL (`regexp_like`, `json_extract_scalar`,
   `dt BETWEEN` pruning, named-table refs) runs **verbatim** — and Trino's Hive connector is the only OSS
   engine that also enforces `injected` partition projection (`InjectedProjection.java`). floci stays in the
   stack for S3 + the other AWS APIs the platform uses (SQS/SNS/etc.); only cold-tier SQL routes to Trino.
   Concrete stack (web-verified, June 2026): `minio/minio` + `postgres:16` (HMS backing) +
   `apache/hive:4.1.0` (metastore — NOT the 6-yr-stale `bitsondatadev` image) + `trinodb/trino:482`.

3. **Tenant-isolation guard locally = app-side SQL fitness function; injected-projection = real-AWS CI smoke.**
   The `injected` projection (engine refuses a cold query lacking `tenant_id=`) is AWS-proprietary and not
   reproducible in any general emulator. cold-tier.md §4 / NFR-6 **already mandates** the enforced local guard:
   the cold `LogStore` adapter must **reject any generated SQL lacking `tenant_id = <ctx>` before
   `StartQueryExecution`** (an AST check — sqlglot-style — not a substring match). Validate the proprietary
   projection behavior with a small **real-AWS CI smoke test** (write Parquet to real S3, register the Glue
   table with injected projection, run the 4 canary queries incl. a no-tenant query that must fail
   `CONSTRAINT_VIOLATION`). Trino additionally enforces it locally as belt-and-suspenders.

4. **Kinesis — risk closed.** Nothing in the build path uses Kinesis Data Streams. Remove it from the
   "unverified floci gaps" list.

5. **Glacier / lifecycle-to-archive — deferral confirmed.** Cold stays S3-standard for MVP. Revisit trigger
   unchanged: when production cold-storage cost becomes material, apply `PutBucketLifecycleConfiguration`
   to the real S3 bucket (standard API, no local validation needed). Do not substitute localstack.

6. **Cold search stays feature-flagged** until #17 implements direct-write + the fitness function and the
   real-AWS smoke test passes.

---

## What #17 must now do (changed scope)

- Implement `ColdArchive` as **processor-batched direct S3 Parquet write** (a Parquet encoder + S3 PutObject
  under the §1 key layout), **not** a Firehose client. Register partitions via explicit `glue.CreatePartition`
  after each flush.
- Implement the cold read path's **SQL fitness function** (reject SQL without a static `tenant_id` predicate).
- Add the **Trino + HMS + MinIO** local compose overlay for cold-query integration tests (queries identical
  to production Athena).
- Add the **real-AWS cold-tier CI smoke test** (gated on main/release; injected-projection + dialect canaries).
- Keep cold search behind its feature flag until the above are green.

## Residual gaps (real-AWS only — cannot close locally)

Injected-projection edge cases (IN-lists), IAM/Lake-Formation auth, Athena result-format and timestamp-precision
nuances. Covered by the CI smoke test, not local emulation.

---

## Evidence index

- `docs/data/spikes/013-firehose-glue-fidelity.md` — Firehose FAIL (source-confirmed), Glue/S3 PASS.
- `docs/data/spikes/014-athena-projection-fidelity.md` — DuckDB-sidecar dialect FAIL, injected-projection not enforced.
- `docs/data/spikes/015-kinesis-glacier-deferral.md` — Kinesis unused, Glacier deferral confirmed.
- Independent web research (floci=DuckDB sidecar; Trino sole faithful OSS engine) corroborated #14's empirical
  finding and supplied the concrete Trino/HMS/MinIO stack + migration estimate (~1 sprint).
