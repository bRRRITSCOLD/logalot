// Package logstore is the Postgres adapter for the hot-tier kernel.LogStore port
// (ADR-0003). It is a shared module: the processor (#7) uses Append on the write
// path and the query-service (#8/#10) will use Tail/Search on the read path, so
// the SET LOCAL app.tenant_id RLS-arming convention lives in exactly one place
// (DRY).
//
// Every statement runs inside a transaction that first arms Row-Level Security
// from the TenantContext via the kernel convention (kernel.WithTenantScope ->
// SET LOCAL app.tenant_id). The connecting role MUST be the NOSUPERUSER
// logalot_app role (migration 000011) so FORCE ROW LEVEL SECURITY governs it:
// without an armed GUC the policy returns zero rows / rejects the insert
// (fail-closed). The adapter ALWAYS stamps tenant_id from the TenantContext and
// NEVER trusts a TenantID carried on a supplied LogEvent (ADR-0002).
//
// All reads/writes go through the partitioned PARENT table log_events; the
// per-day partitions are an implementation detail of the storage layer.
package logstore
