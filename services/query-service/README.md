# query-service

Go + Gin service for the tenant-scoped read surface (Log Query & Search bounded
context — see `docs/architecture/overview.md` §5.3, ADR-0006).

**Wave 1 scope:** live tail. `GET /v1/tail` streams a tenant's new log events over
Server-Sent Events, sourced from Redis pub/sub `tail:{tenant_id}`. Full-text +
structured + time-range search lands beside it over the `LogStore` port in
**issue #10**.

## Endpoints

| Method | Path        | Auth | Description                                          |
|--------|-------------|------|------------------------------------------------------|
| GET    | `/v1/tail`  | yes  | SSE live tail (requires `Accept: text/event-stream`) |
| GET    | `/healthz`  | no   | Liveness                                             |
| GET    | `/readyz`   | no   | Readiness (Redis reachable)                          |

`/v1/tail` supports optional server-side filters: `?level=<level>` and
`?service=<name>`, applied per message before emission.

## Design

Hexagonal / ports-and-adapters:

- `internal/app` — application core. `Streamer.Stream` subscribes to the tenant's
  tail channel via the `kernel.TailBus` port, applies the `Filter`, and writes
  frames to a transport-agnostic `Sink` with a periodic heartbeat and bounded,
  drop-on-overflow backpressure. Depends only on the kernel port.
- `internal/adapters/httpx` — Gin transport. API-key auth middleware (over the
  swappable `kernel.Authenticator` port), SSE framing (`sseSink`), filter parsing,
  health/readiness.
- `cmd/query-service` — wiring + graceful shutdown.

### Tenant isolation (load-bearing)

The subscribe channel is `tail:{tenant_id}` derived from the verified
`TenantContext` inside the `TailBus` adapter (`kernel.TailChannel`) — never from
user input. Auth runs before any subscribe, so a bad credential never opens a
stream. A connection for tenant A physically cannot receive tenant B's events;
this is proven by the two-tenant integration test.

### SSE / backpressure (ADR-0006)

- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
  `Connection: keep-alive`; each frame is flushed.
- Heartbeat comment (`: keepalive\n\n`) every 15s.
- A pump goroutine drains the bus into a bounded buffer with a non-blocking send;
  on overflow events are dropped and counted, then surfaced to the client as an
  `event: gap` frame — a slow browser never backs up the Redis subscriber or the
  publisher (the processor). Tail is best-effort-lossy by design.
- Client disconnect cancels the request context, which unsubscribes and tears the
  stream down cleanly.

The `Authenticator` port is swappable: the wave-1 slice uses the ingest API-key
authenticator; the wave-2 UI session JWT authenticator slots in with no edge
change.

## Tests

- Unit: `go test ./...` (no Docker).
- Integration (`-tags=integration`): testcontainers Redis on a random port (the
  host runs a conflicting Redis). Proves within-2s receipt and two-tenant
  isolation using the real `pkg/tailbus` Publish to simulate the processor.

```sh
go test ./...                     # unit
go test -tags=integration ./...   # + Docker-backed integration
```
