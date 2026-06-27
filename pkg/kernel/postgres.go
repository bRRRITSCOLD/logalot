package kernel

import "context"

// This file is the ONE place the Postgres tenant-context convention lives (DRY,
// docs/data/model.md §4.1, ADR-0002 §3). Every LogStore/repository adapter arms
// PostgreSQL Row-Level Security from the TenantContext before any tenant-scoped
// statement; if it is never armed, RLS returns zero rows (fail closed).
//
// The kernel stays driver-agnostic: it depends on the tiny ExecFunc closure, not
// on database/sql or pgx. An adapter wires either driver in one line, e.g.:
//
//	exec := func(ctx context.Context, sql string, args ...any) error {
//	    _, err := tx.ExecContext(ctx, sql, args...) // *sql.Tx or pgx adapter
//	    return err
//	}

// TenantGUC is the authoritative GUC name. It MUST match the RLS policies and
// app.current_tenant_id() helper in the migrations exactly (model.md §4.1).
const TenantGUC = "app.tenant_id"

// SetLocalTenantStmt is the parameterized, transaction-scoped statement the
// convention emits. `SET LOCAL` itself cannot take a bind parameter, so the
// equivalent is set_config(name, value, is_local=true): is_local=true makes it
// transaction-scoped exactly like SET LOCAL, and the bind keeps it injection-safe
// (model.md §4.1). The $1 value is the TenantContext's tenant uuid.
const SetLocalTenantStmt = `SELECT set_config('app.tenant_id', $1, true)`

// ExecFunc is the minimal, driver-agnostic statement executor the convention
// needs. Adapters supply a closure over *sql.Tx / *sql.Conn / pgx.Tx.
type ExecFunc func(ctx context.Context, sql string, args ...any) error

// ArmTenant arms RLS for the current transaction from tc. It validates the
// tenant first and refuses to execute anything for a blank/invalid tenant
// (returns ErrNoTenantContext / ErrInvalidTenantID) — fail closed.
func ArmTenant(tc TenantContext, ctx context.Context, exec ExecFunc) error {
	if err := tc.Valid(); err != nil {
		return err
	}
	return exec(ctx, SetLocalTenantStmt, string(tc.TenantID))
}

// WithTenantScope is the unit-of-work wrapper: it arms RLS, then runs the
// tenant-scoped work in the same transaction. If arming fails (no/invalid
// tenant), work is NOT run. This is the recommended entry point for adapters so
// no statement can run before the GUC is set.
func WithTenantScope(tc TenantContext, ctx context.Context, exec ExecFunc, work func() error) error {
	if err := ArmTenant(tc, ctx, exec); err != nil {
		return err
	}
	return work()
}

// LiteralSetLocal renders the convention's verbatim literal form,
// `SET LOCAL app.tenant_id = '<uuid>'` (model.md §4.1), for debugging, psql, or
// transaction-less contexts. It is injection-safe because Valid() guarantees the
// id is a hex/dash UUID before interpolation. Prefer ArmTenant/WithTenantScope on
// the live path; this exists for parity with the documented convention text.
func LiteralSetLocal(tc TenantContext) (string, error) {
	if err := tc.Valid(); err != nil {
		return "", err
	}
	return "SET LOCAL app.tenant_id = '" + string(tc.TenantID) + "'", nil
}
