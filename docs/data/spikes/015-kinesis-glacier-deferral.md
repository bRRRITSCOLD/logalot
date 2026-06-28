# Spike #015 — Kinesis Unused Confirmation + floci Glacier/Lifecycle Deferral

**Issue:** [#15](https://github.com/bRRRITSCOLD/logalot/issues/15)
**Date:** 2026-06-27
**Author:** backend-engineer agent
**floci version:** 1.5.28 community edition
**Verdict:**
- (a) **Kinesis Data Streams: CONFIRMED UNUSED** — zero references in the build path.
- (b) **Glacier / S3 lifecycle-to-archive: DEFERRED (CONFIRMED)** — floci stores and returns the
  lifecycle configuration and GLACIER storage class field, but enforces no actual archive semantics.
  Deferral is appropriate; revisit trigger: cold storage cost becomes material.

---

## 1. Scope

Two informational floci gaps carried forward from the architecture NFR backlog (`docs/architecture/nfr.md`):

| Gap | Status entering this spike |
|---|---|
| Kinesis Data Streams support on floci unverified | Risk — not used; confirm and close |
| Glacier / S3 lifecycle-to-archive support unverified | Tracked risk — cold stays S3 standard; verify and close the deferral |

---

## 2. Part (a) — Kinesis Data Streams: CONFIRMED UNUSED

### 2.1 Architecture decision (already documented)

ADR-0004 (`docs/adr/0004-ingest-transport-and-queue.md`) explicitly evaluated and rejected Kinesis as the
ingest transport. The chosen broker is **RabbitMQ** for all message delivery (ingest-service →
processor, fan-out to alert-evaluator). The cold-tier write path is direct S3 Parquet (per spike #013;
Firehose dropped). There is no buffering or streaming layer that touches Kinesis.

### 2.2 Grep evidence — zero build-path references

All search scopes returned zero results:

| Scope | Command | Result |
|---|---|---|
| Go source files (`*.go`) | `find … -name "*.go" \| xargs grep -i "kinesis"` | **0 matches** |
| Go module dependencies (`go.mod`) | `find … -name "go.mod" \| xargs grep -i "kinesis"` | **0 matches** |
| TypeScript / Node source (`*.ts`, `*.tsx`, `package.json`) | `find apps/ packages/ -name "*.ts" …` | **0 matches** |
| Infra (docker-compose, Makefile, scripts) | `grep -r -i "kinesis" …` | **0 matches** |

Kinesis references in the repository exist **only in documentation** (ADR-0004 options table,
`nfr.md` gaps table, `overview.md` caveat note, `roadmap.md` issue list) — the exact places that
previously flagged it as an unverified risk.

### 2.3 floci health confirms Kinesis is running on the emulator

floci 1.5.28's `GET /_floci/health` response includes `"kinesis":"running"`, confirming floci does
expose a Kinesis endpoint. This has no effect on this project: nothing in the codebase calls it.

### 2.4 Conclusion

**CONFIRMED UNUSED.** No service, package, or test module in the monorepo imports the Kinesis SDK
(`github.com/aws/aws-sdk-go-v2/service/kinesis`) or makes any Kinesis API call. The floci Kinesis
gap is a non-risk: the architecture chose RabbitMQ (a reliable, composable broker with routing
semantics) for ingest, and the gap never materialised as a build-path dependency.

---

## 3. Part (b) — floci Glacier / S3 Lifecycle-to-Archive: DEFERRED (CONFIRMED)

### 3.1 What was probed

The probe is encoded as `TestGlacierLifecycleProbe` in
`tests/cold-tier-spike/glacier_probe_test.go` (build tag `floci_spike`), three sub-tests:

| Sub-test | API call | Question answered |
|---|---|---|
| `LifecycleConfigRoundTrip` | `PutBucketLifecycleConfiguration` + `GetBucketLifecycleConfiguration` | Does floci accept and store a Glacier transition rule? |
| `StorageClassGlacierPutObject` | `PutObject(StorageClass=GLACIER)` + `HeadObject` + `GetObject` | Does floci preserve the GLACIER storage class, and does it enforce archive semantics? |
| `RestoreObjectStub` | `RestoreObject` | Does floci support a Glacier restore request? |

### 3.2 Environment

```
floci version : 1.5.28 community
endpoint      : http://localhost:4566
AWS_REGION    : us-east-1
credentials   : test / test  (compose .env defaults)
probe bucket  : logalot-glacier-probe
```

### 3.3 Raw test output

```
=== RUN   TestGlacierLifecycleProbe
    glacier_probe_test.go:40: floci endpoint: http://localhost:4566 region: us-east-1
=== RUN   TestGlacierLifecycleProbe/LifecycleConfigRoundTrip
    glacier_probe_test.go:49: PROBE (LifecycleConfig): PutBucketLifecycleConfiguration succeeded (no error)
    glacier_probe_test.go:49: VERDICT LifecycleConfig: ROUND-TRIP PASS — rule ID
        "glacier-transition-probe-1782612726784733530" survived with StorageClass=GLACIER transition.
        floci stores and returns the lifecycle configuration. (Whether floci ENFORCES the
        transition at object level is a separate question probed in StorageClassGlacierPutObject.)
=== RUN   TestGlacierLifecycleProbe/StorageClassGlacierPutObject
    glacier_probe_test.go:52: PROBE (StorageClass=GLACIER): PutObject accepted (no error).
        Key: probe/glacier-sc-1782612726785298820.txt
    glacier_probe_test.go:52: VERDICT StorageClass: ROUND-TRIP PASS — floci returned
        StorageClass=GLACIER on HeadObject. The storage class field is stored and returned.
        (DEEP_ARCHIVE or GLACIER_IR not probed — same API path.)
    glacier_probe_test.go:52: PROBE (StorageClass=GLACIER): GetObject succeeded immediately —
        no restore required. floci treats GLACIER objects as immediately readable
        (no real archive tiering enforced).
=== RUN   TestGlacierLifecycleProbe/RestoreObjectStub
    glacier_probe_test.go:55: VERDICT RestoreObject: STUB PASS — floci accepted RestoreObject
        without error. Per floci docs/services/s3.md: 'RestoreObject is acknowledged but only
        returns a stub response without executing restoration logic.'
        This confirms: there is no real Glacier restore pipeline.
--- PASS: TestGlacierLifecycleProbe (0.00s)
    --- PASS: TestGlacierLifecycleProbe/LifecycleConfigRoundTrip (0.00s)
    --- PASS: TestGlacierLifecycleProbe/StorageClassGlacierPutObject (0.00s)
    --- PASS: TestGlacierLifecycleProbe/RestoreObjectStub (0.00s)
PASS
```

### 3.4 Findings per probe

**Probe 1 — Lifecycle configuration round-trip: PASS (surface only)**

`PutBucketLifecycleConfiguration` with a 30-day Glacier transition rule is accepted without error.
`GetBucketLifecycleConfiguration` returns the rule intact, including `StorageClass=GLACIER` in the
`Transitions` field. The configuration API surface works.

**Probe 2 — StorageClass=GLACIER on PutObject: PASS (field stored) + STUB (no enforcement)**

`PutObject` with `StorageClass=GLACIER` succeeds. `HeadObject` returns `StorageClass=GLACIER` —
the field is stored and returned correctly. However, `GetObject` on the same object **succeeds
immediately**, without any `RestoreObject` call. In production AWS, a GLACIER-class object is not
directly readable — it requires a restore request (Expedited/Standard/Bulk, hours to days of
latency) before `GetObject` succeeds. floci returns the storage class label but imposes no access
barrier. There is no actual tiering, no cost reduction, and no restore latency.

**Probe 3 — RestoreObject: STUB**

`RestoreObject` returns success. This is consistent with floci's own documentation
(`docs/services/s3.md` @ 1.5.28):
> "RestoreObject is acknowledged but only returns a stub response without executing restoration logic."

This confirms: there is no Glacier restore pipeline in floci. The call is silently accepted and
discarded.

### 3.5 floci source / docs corroboration

floci's `docs/services/s3.md` (tag 1.5.28, `github.com/floci-io/floci`) lists
`PutBucketLifecycle`, `GetBucketLifecycle`, `DeleteBucketLifecycle` as supported operations but
provides no description of lifecycle evaluation, transition scheduling, or storage-tier semantics.
`RestoreObject` is the only lifecycle-adjacent operation explicitly documented as a stub. There is
no mention of a background lifecycle evaluation job, Glacier tier isolation, or storage-class cost
distinction in the emulator source or docs.

### 3.6 Verdict and deferral rationale

| Question | Finding |
|---|---|
| Does floci accept lifecycle configuration with Glacier transitions? | **YES** — API surface works, rules round-trip |
| Does floci enforce lifecycle transitions (actually move objects)? | **NO** — no background evaluation job; objects stay immediately accessible |
| Does floci preserve GLACIER storage class on PutObject → HeadObject? | **YES** — field stored and returned |
| Does floci enforce Glacier access semantics (GetObject blocked until restored)? | **NO** — GetObject succeeds immediately; RestoreObject is a stub |
| Can we validate archive tiering behaviour locally against floci? | **NO** — there is no meaningful validation possible |

**DEFERRAL CONFIRMED.**

Archive tiering (Glacier transition via S3 lifecycle rule) is a production-only cost optimization.
floci stores the configuration and field values correctly, but provides no enforcement — local
testing cannot validate what production Glacier actually does (access barrier, restore latency,
tiered pricing). The deferral is therefore not a gap to fill locally; it is correct to skip for
MVP and apply only when real production cost warrants it.

The production path is straightforward and requires no special local validation:
- Apply a `PutBucketLifecycleConfiguration` rule to the real `logalot-cold` S3 bucket with a
  `Transition` to `GLACIER` (or `INTELLIGENT_TIERING`) after the desired age threshold.
- Real AWS enforces the transition; objects move to GLACIER and become inaccessible without a
  restore. The `cold-tier.md §4` query pattern is unaffected — Athena queries S3 Parquet objects
  that have not been transitioned; for data that needs restore, the cold path would need a restore-
  and-wait step, which is out of scope for MVP search latency targets.

### 3.7 Revisit trigger

**Revisit when:** cold storage cost on the production S3 bucket becomes material (visible in AWS
Cost Explorer as `S3 Standard - Storage` or `S3 Select` line items meaningful relative to
overall spend). At that point, add the lifecycle rule directly to the production bucket — no
floci/local validation needed, since the API surface is standard AWS S3 and the configuration
round-trips correctly in both environments.

---

## 4. Reproducible probe

The Glacier probe is at `tests/cold-tier-spike/glacier_probe_test.go` (build tag `floci_spike`).
Run against compose floci (`make up` first):

```
go test -tags=floci_spike -run TestGlacierLifecycleProbe -v -timeout 120s \
    ./tests/cold-tier-spike/...
```

All three sub-tests pass (the suite is informational, not a PASS/FAIL gate — findings are
recorded in the test log, not as assertion failures).

---

## 5. What this spike does NOT validate

- **DEEP_ARCHIVE or GLACIER_IR storage classes**: not probed; the same API path applies and the
  same non-enforcement conclusion would follow. GLACIER is sufficient to confirm the pattern.
- **Lifecycle rule evaluation / transition scheduling**: not provable locally. floci does not
  expose a configurable clock or a way to trigger "evaluate lifecycle rules now."
- **Production Athena behaviour against GLACIER-class objects**: Athena on real AWS does not read
  GLACIER-class objects (they require restore); floci's Athena sidecar was validated in spike #014
  as a DuckDB proxy and does not distinguish storage classes either.
- **Cost impact modelling**: out of scope; driven entirely by production usage.

---

## 6. Ledger floci-gaps status update (to be folded into the ledger)

The following status lines replace the two open rows in the ledger's `floci gaps` table. They are
staged here (not in `.superpowers/delivery-progress.md`) per issue #15 instructions.

```
- floci **Kinesis Data Streams** unverified — CONFIRMED UNUSED. Zero build-path references
  (no go.mod import, no source call site, no compose config). Broker is RabbitMQ; cold is
  direct-write S3. Gap CLOSED (spike #015, 2026-06-27).

- floci **Glacier** / S3 lifecycle-to-archive support unverified — DEFERRAL CONFIRMED.
  floci accepts and round-trips lifecycle configuration (PutBucketLifecycleConfiguration PASS)
  and GLACIER storage class on objects (PutObject/HeadObject PASS), but enforces NO archive
  semantics: GetObject on GLACIER objects succeeds immediately; RestoreObject is a documented
  stub. Local validation of archive tiering is not meaningful. Cold stays S3 Standard for MVP.
  Revisit trigger: cold storage cost becomes material in production. Gap CLOSED (spike #015,
  2026-06-27).
```
