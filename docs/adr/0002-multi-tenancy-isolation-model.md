# ADR-0002: Multi-tenancy isolation model

- **Status:** Accepted
- **Date:** 2026-06-26
- **Deciders:** systems architect (+ data architect)
- **Related:** spec §Multi-tenancy, overview.md §6, ADR-0003, ADR-0005, ADR-0007, NFR-6

## Context

Tenant isolation (data + auth) is a first-class, non-negotiable requirement: **zero cross-tenant
leakage**, enforced at storage + query + auth layers (defense in depth). The platform targets hundreds
of small/medium tenants on a single cluster, with cost and operational simplicity mattering (we are
avoiding SaaS pricing). The classic models are:

- **Siloed** — a store/index/schema per tenant. Strongest isolation, highest per-tenant cost and ops.
- **Pooled** — shared store, every row/object scoped by `tenant_id`. Cheapest, highest leakage risk if
  scoping is ever missed.
- **Bridge** — pooled by default, siloed for specific large/sensitive tenants.

We must pick where and how isolation is enforced, and how tenant context propagates from auth to storage.

## Decision

Adopt **pooled isolation with hard, multi-layer enforcement** as the default, with a **bridge escape
hatch** for large tenants. Concretely:

1. **Identity:** every credential resolves to exactly one `tenant_id`. API keys are bound to a tenant at
   issue time; session JWTs carry a `tenant_id` claim (ADR-0007). Tenant identity is **never** taken from
   the request body or query string.
2. **Context object:** edge middleware constructs `TenantContext{tenant_id, principal_id, role, scopes}`
   and passes it explicitly down the call stack (no globals). It is the **mandatory first parameter** of
   every port/repository method — there is no un-scoped overload. A contract test enforces this.
3. **Hot storage (defense layer 1):** `tenant_id` is part of the **partition key and primary-key prefix**
   (ADR-0003). PostgreSQL **Row-Level Security** is enabled as a fail-closed backstop:
   policy `tenant_id = current_setting('app.tenant_id')::uuid`; the value is set per transaction via
   `SET LOCAL app.tenant_id`. If unset, **zero rows** are returned/writable.
4. **Cold storage (defense layer 2):** every object is keyed under `s3://logalot-cold/tenant_id=<id>/...`;
   the Glue table is partitioned on `tenant_id`; Athena SQL is generated with the `tenant_id` partition
   predicate bound from `TenantContext` (ADR-0005).
5. **Tail bus (defense layer 3):** Redis channel `tail:{tenant_id}`; the subscribe target is derived from
   context (ADR-0006).
6. **Bridge escape hatch:** a tenant can be promoted to a **dedicated partition set / schema / cold bucket
   prefix** without API changes, because all access already routes through `TenantContext` and the
   `LogStore` port. Promotion is a data/ops operation, not a code change.

## Status

Accepted. Pooled is the default for all tenants in v1. The bridge promotion path is designed-for but not
implemented in the slice.

## Consequences

### Positive
- Cost/ops optimal for hundreds of tenants: one store to run, one cold bucket, shared pipeline.
- Defense in depth: a single missed `WHERE` clause cannot leak data because RLS (hot) and partition-prefix
  binding (cold) and channel naming (tail) each independently fail closed.
- Tenant context is explicit and testable end to end — the isolation invariant is a fitness function, not a
  hope.

### Negative / costs
- Pooled means a "noisy neighbor" can affect shared resources; mitigated by per-tenant rate limiting at
  ingest and partition-level isolation in the hot store, plus the bridge path for outliers.
- RLS adds a small per-query overhead and requires the `SET LOCAL` discipline in the data adapter.

### Trigger to revisit
- Promote a tenant to **siloed (bridge)** when its hot volume dominates shared partitions (search p95
  regression attributable to one tenant) or a compliance requirement demands physical separation.
- Reconsider the whole model only if tenant count grows past the single-cluster pooled sweet spot
  (thousands), which is outside current scope.

## Alternatives considered

| Option | Leakage risk | Cost @ hundreds of tenants | Ops complexity | Large-tenant fit | Verdict |
|---|---|---|---|---|---|
| **Pooled + hard enforcement + bridge (chosen)** | Low (4 layers, fail-closed) | Low | Medium | Good (promote) | **Chosen** |
| Pure pooled (tenant_id filter only) | Medium-High | Lowest | Low | Poor | Rejected — single missed predicate = leak |
| Siloed (store/schema per tenant) | Lowest | High | High | Excellent | Rejected — cost/ops unjustified at this scale |

- **Pure pooled:** cheapest but relies on every query being correct; one mistake leaks across tenants. The
  RLS + partition-prefix backstops are cheap insurance we are unwilling to skip.
- **Siloed:** strongest isolation, but provisioning/operating hundreds of stores/indexes/buckets contradicts
  the cost and KISS goals. We keep it available as the bridge promotion for the few tenants that need it.
