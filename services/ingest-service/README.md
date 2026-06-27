# ingest-service

Go + Gin service for authenticated high-throughput log intake (Ingestion bounded
context — see `docs/architecture/overview.md`, ADR-0004).

`POST /v1/ingest` accepts a single JSON event or NDJSON bulk, authenticates the
tenant from an API key (never the body), enforces a per-tenant rate limit, then
publishes durable envelopes to RabbitMQ — returning **202** only after a
publisher confirm.

## Request pipeline

```
auth (API key → TenantContext) → rate-limit (per-tenant) → validate → publish (202)
```

- **401/403** on missing/invalid key or missing `ingest:write` scope.
- **429** + `Retry-After` when the tenant exceeds its rate limit.
- **400/415** on malformed/unsupported body.
- **202** only after a durable, publisher-confirmed enqueue.

## Per-tenant rate limiting (ADR-0004, NFR-3)

A **Redis token bucket** keyed by the authenticated `tenant_id`. Each tenant has
an independent bucket (capacity `burst`, refilled at `rate` tokens/sec), so one
tenant exhausting its limit never throttles another. The refill+take step runs as
a single atomic Lua script, so concurrent ingest replicas cannot over-admit.

On a Redis outage the limiter **fails open by default** (admits + logs a warning),
preferring ingest availability over enforcement; set `INGEST_RATE_LIMIT_FAIL_OPEN=false`
to fail closed (503) instead.

### Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `INGEST_RATE_LIMIT_ENABLED` | `true` | Master switch; `false` disables the middleware. |
| `INGEST_RATE_LIMIT_RPS` | `1000` | Default sustained requests/sec per tenant. |
| `INGEST_RATE_LIMIT_BURST` | `2000` | Default bucket capacity per tenant. |
| `INGEST_RATE_LIMIT_FAIL_OPEN` | `true` | Behaviour on Redis outage: admit (true) vs 503 (false). |
| `INGEST_RATE_LIMIT_OVERRIDES` | _(empty)_ | Per-tenant overrides: `<tenant-uuid>=<rps>:<burst>,...` |

**Setting a per-tenant limit:** add the tenant to `INGEST_RATE_LIMIT_OVERRIDES`,
e.g. `INGEST_RATE_LIMIT_OVERRIDES="11111111-1111-1111-1111-111111111111=5000:10000,2222...=0:0"`.
A `0:0` entry exempts a tenant (unlimited). Resolution sits behind a `Resolver`
port, so a Redis- or control-plane-backed source can replace the env map later
without touching the limiter.

## Tests

```sh
go test ./...                 # unit (fast, no Docker)
go test -tags=integration ./... # + testcontainers Redis/RabbitMQ
```
