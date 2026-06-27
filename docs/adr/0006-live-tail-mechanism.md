# ADR-0006: Live-tail mechanism

- **Status:** Accepted
- **Date:** 2026-06-26
- **Deciders:** systems architect
- **Related:** spec §Live tail, overview.md §5.3, ADR-0002, ADR-0003, NFR-3, NFR-6

## Context

Live tail must stream matching, **tenant-scoped** logs to the browser with **end-to-end latency < 2s**
from ingest. We need (a) a fan-out mechanism from the processor to many concurrent subscribers, and (b) a
browser transport. The data flow is **unidirectional** (server → client); the client only opens/closes the
stream and sends filters at open time. Redis is already in the stack.

## Decision

- **Fan-out:** **Redis pub/sub**. After persisting an event, the processor `PUBLISH`es it to channel
  `tail:{tenant_id}`. `query-service` holds one Redis subscription per channel (shared across that tenant's
  connections) and dispatches to matching SSE clients. Channel naming is the tenant-isolation layer for
  tail (ADR-0002): a connection can only subscribe to `tail:{tenant_id}` derived from its `TenantContext`.
  > **Implementation note (slice, #8):** the initial query-service opens one Redis subscription **per
  > connection** (KISS) rather than the shared-per-tenant fan-out described above. The `TailBus` port
  > localizes the change, so shared fan-out can land later without touching callers. Tracked as a deferred
  > optimization; isolation is unaffected (channel name is still context-derived).
- **Browser transport:** **Server-Sent Events (SSE)** via `GET /v1/tail` (`text/event-stream`). Client
  uses native `EventSource` (auto-reconnect, `Last-Event-ID`). Heartbeat comment every 15s to keep
  intermediaries from closing idle connections.
- **Filtering:** client-supplied filters (level, label/field, substring) are applied in `query-service`
  per message before emit; the channel carries the tenant's full stream, filtering is per-subscription.
- **Slow-consumer protection:** bounded per-connection buffer; on overflow, sample/drop and emit a `gap`
  event so a slow browser never backs up the bus or the processor.
- **Ports:** processor depends on a `TailBus` port (Redis adapter); `query-service` depends on `TailBus`
  for subscribe.

## Status

Accepted. SSE + Redis pub/sub is the slice mechanism. WebSocket is explicitly **not** adopted now.

## Consequences

### Positive
- SSE is the simplest correct fit for unidirectional streaming: native browser support, automatic
  reconnection, plain HTTP (works through proxies, rides HTTP/2 multiplexing), trivial to authenticate
  with the session JWT (NFR-3, NFR-5).
- Redis pub/sub gives sub-millisecond fan-out and is already in the stack (no new infra); tenant channels
  make isolation structural (NFR-6).
- Decoupled from durability: tail is best-effort and lossy-by-design under overload, which keeps it from
  ever endangering the ingest/persist path (NFR-2).

### Negative / costs
- Redis pub/sub is **fire-and-forget** (no replay): a subscriber that is down misses messages. Acceptable —
  live tail is "now"; historical gaps are served by search. `Last-Event-ID` lets the client backfill a
  short window via a search query on reconnect if desired.
- SSE over HTTP/1.1 is limited by per-domain connection caps; mitigated by HTTP/2 (the BFF terminates
  HTTP/2). WebSocket would avoid this but adds bidirectional complexity we don't need.
- Pub/sub does not survive a Redis restart; fan-out resumes automatically, with the same "missed = search"
  contract.

### Trigger to revisit
- Adopt **WebSocket** only if the tail UI gains genuine bidirectional needs (e.g. interactive server-side
  query steering mid-stream).
- Adopt **Redis Streams** (instead of pub/sub) if we need bounded replay / consumer-group delivery for tail
  (e.g. guaranteed no-miss within a window). The `TailBus` port localizes either change.

## Alternatives considered

| Option (transport) | Browser fit | Reconnect | Bidirectional | Complexity | Verdict |
|---|---|---|---|---|---|
| **SSE (chosen)** | Native EventSource | Built-in | No | Low | **Chosen** |
| WebSocket | Native | Manual | Yes | Medium | Rejected — unneeded bidirectionality |
| Long-polling | Works | Manual | No | Medium | Rejected — inefficient, higher latency |

| Option (fan-out) | Latency | Replay | New infra | Verdict |
|---|---|---|---|---|
| **Redis pub/sub (chosen)** | Sub-ms | No | None | **Chosen** |
| Redis Streams | Sub-ms | Yes (bounded) | None | Escape hatch (if no-miss needed) |
| RabbitMQ fanout | Low | Limited | In stack | Rejected — heavier than needed for ephemeral tail |

- **WebSocket:** appropriate only if/when tail becomes bidirectional; SSE is strictly simpler for
  server→client and gives free reconnection.
- **Redis Streams / RabbitMQ fanout:** both add delivery guarantees the live-tail use case doesn't need;
  "missed messages are recovered via search" is the deliberate, simpler contract.
