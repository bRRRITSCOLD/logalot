# ADR-0004: Ingest transport and pipeline queue

- **Status:** Accepted
- **Date:** 2026-06-26
- **Deciders:** systems architect
- **Related:** spec §Ingest/§Pipeline, overview.md §5.1, ADR-0001, NFR-1, NFR-2, NFR-3

## Context

Ingest is the throughput-critical hot path: **≥50k events/s per node**, horizontally scalable, with
**backpressure**, **validation**, and **no acknowledged-event loss**. Between intake and persistence we
need a **durable buffer** so ingest throughput is decoupled from hot-store write latency and so spikes
become queue depth rather than dropped data or immediate client back-pressure. The local infra already
includes **RabbitMQ**, chosen as the pipeline broker; the prompt instructs us to justify it in an ADR and
not reopen it without a hard reason.

## Decision

- **Transport:** `POST /v1/ingest` implemented in **Go + Gin**. Stateless; auth via tenant API key
  (ADR-0007); supports single event and bulk **NDJSON**. Returns **202 Accepted** only after a durable
  publish; **400** on validation failure, **401** on auth failure, **429** on per-tenant rate/backpressure
  limit.
- **Broker:** **RabbitMQ**. The ingest exchange routes to a durable work queue consumed by `processor`
  (competing consumers, manual ack, tuned prefetch). A **dead-letter exchange → DLQ** captures poison
  messages after bounded retries.
- **Message contract (published language):** `{tenant_id, received_at, source_ip?, raw}` where `tenant_id`
  is resolved from the **authenticated key**, not the body. Messages are published **persistent**; the
  queue is **durable**; publisher confirms are enabled so `202` is only returned after broker ack.
- **Backpressure:** per-tenant token-bucket rate limiting in Redis at ingest; when queue depth or the
  per-tenant limit is exceeded, ingest returns `429` with `Retry-After`.
- **Ports:** ingest depends on a `Broker` port; processor depends on `Broker` + `LogStore` + `ColdArchive`
  + `TailBus`. RabbitMQ is one `Broker` adapter.

## Status

Accepted. Go+Gin for ingest is confirmed (spec default, throughput fit). RabbitMQ is confirmed as broker;
not reopened.

## Consequences

### Positive
- Go+Gin gives low-overhead, GC-friendly concurrency that comfortably handles 50k/s/node without latency
  cliffs; ingest scales horizontally as a stateless tier.
- Durable queue decouples intake from persistence → spikes absorbed, no data loss on `202`, processors
  scale independently (NFR-1, NFR-2).
- RabbitMQ's per-message ack + DLX/DLQ + management UI give exactly the retry/DLQ + operator-visibility
  semantics the spec calls for, with no new infra.

### Negative / costs
- RabbitMQ throughput per node is lower than a log-structured broker (Kafka); at the very top of the
  scale range this could require careful queue sharding. Acceptable at single-cluster scale.
- Two-phase delivery (202 then async persist) means clients see eventual, not immediate, searchability —
  acceptable and expected for a logging pipeline; covered by the <2s live-tail budget.

### Trigger to revisit
- Move to **Kafka/Redpanda** only if RabbitMQ becomes the ingest bottleneck (sustained inability to drain
  at target throughput with reasonable queue sharding) **or** if replay/long-retention-on-the-broker
  becomes a requirement. The `Broker` port localizes the change. This is a hard-reason-only reopen.

## Alternatives considered

| Option | Throughput | Durability / DLQ | Ops (new infra?) | Replay | Verdict |
|---|---|---|---|---|---|
| **Go+Gin → RabbitMQ (chosen)** | High enough | Strong (confirms + DLX) | None (in stack) | Limited | **Chosen** |
| Kafka / Redpanda | Highest | Strong (log) | New infra | Excellent | Rejected — YAGNI at this scale |
| floci Kinesis / SQS | Medium | Medium | floci (unverified) | Kinesis: yes | Rejected — floci Kinesis unverified; SQS lacks broker semantics |
| Direct write (no queue) | Low | Weak | Lowest | None | Rejected — couples intake to store, loses backpressure/durability |

- **Kafka/Redpanda:** the "correct" choice at hyperscale and the natural escape hatch, but it adds a major
  new stateful system the spec's scale does not require.
- **floci Kinesis/SQS:** Kinesis support on floci is unverified (tracked risk) and SQS lacks the routing
  + per-message work-queue + DLX ergonomics we want; using RabbitMQ avoids that risk entirely. (floci SQS
  *is* used elsewhere for alert dispatch — ADR for alerting — but not as the ingest broker.)
- **Direct write:** discards the durability/backpressure/decoupling that are the whole point of the pipeline.
