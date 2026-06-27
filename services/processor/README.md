# processor

Go worker (ADR-0001, Log Processing bounded context). Consumes ingest envelopes
from RabbitMQ, normalizes each to a `LogEvent`, persists it to the hot store
`log_events` under the tenant's RLS context, and fans it out to the live-tail bus
on `tail:{tenant_id}` (Redis pub/sub, ADR-0006).

Built in **issue #7**. The cold-tier tee (Firehose/S3) is out of scope here (#17).

## Flow

```
RabbitMQ (logalot.ingest.events)
   │  prefetch + manual ack; per-message TenantContext rebuilt from envelope tenant_id
   ▼
broker.Consume ──► app.Handle
   1. Normalize(Envelope.Raw) ──► LogEvent      (tolerant; poison → DLQ, no retry)
   2. logstore.Append (RLS-armed tx, batched)   (transient fail → bounded retry → DLQ)
   3. tailbus.Publish tail:{tenant_id}          (best-effort; failure logged, message still acked)
   ▼
ack  (or nack-without-requeue → DLX → logalot.ingest.events.dlq)
```

## Modules it wires (ports + adapters)

| Port (`pkg/kernel`) | Adapter | Module |
| --- | --- | --- |
| `Broker.Consume` | RabbitMQ (shared, from #6) | `pkg/broker` |
| `LogStore.Append` | Postgres, RLS-armed (`SET LOCAL app.tenant_id`) | `pkg/logstore` |
| `TailBus.Publish` | Redis pub/sub | `pkg/tailbus` |

`pkg/logstore` and `pkg/tailbus` are shared modules reused by the query-service
(#8 tail read / #10 search).

## Retry / DLQ semantics

- **Poison** (payload not normalizable at all): returned immediately → broker
  nacks without requeue → DLQ. Retrying it could never succeed.
- **Transient persist failure**: bounded retry (`PROCESSOR_MAX_RETRIES`, default
  3) with linear backoff; recovers and acks, or exhausts the budget and
  dead-letters as an operator-inspectable poison-persist.
- **Tail publish failure**: logged, message still acked — the row is durably
  committed and re-delivery would double-insert (tail is best-effort, ADR-0006).

## Multi-tenancy (load-bearing)

The persisted `tenant_id` and the tail channel are taken ONLY from the
`TenantContext` the broker rebuilds from the envelope's authoritative tenant_id —
never from the event body (ADR-0002). The insert runs as the NOSUPERUSER
`logalot_app` role inside a `SET LOCAL app.tenant_id` transaction, so FORCE ROW
LEVEL SECURITY makes an event for tenant A invisible under tenant B.

## Config (env)

`RABBITMQ_URL` (or host/port parts) · `LOGALOT_APP_DATABASE_URL` (logalot_app
role) · `REDIS_HOST`/`REDIS_PORT`(/`REDIS_PASSWORD`) · `PROCESSOR_PREFETCH`
(default 64) · `PROCESSOR_MAX_RETRIES` (default 3).

## Test

```sh
go test ./...                     # unit (Docker-free)
go test -tags=integration ./...   # broker+postgres+redis testcontainers (random ports)
```
