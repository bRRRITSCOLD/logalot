import type { Pool, PoolClient } from 'pg';

// withTenantTx runs `fn` inside a transaction that has armed Postgres RLS for the
// given tenant. This is the Node mirror of the Go kernel's WithTenantScope and the
// single tenant-context convention (model.md §4.1):
//
//   SELECT set_config('app.tenant_id', $1, true)   -- `true` == SET LOCAL (tx-scoped)
//
// set_config with a bind parameter is used instead of `SET LOCAL app.tenant_id =
// '...'` because SET does not accept parameters; the third arg `true` makes it
// transaction-local so a pooled connection never leaks one request's tenant into
// the next. The app connects as the NOSUPERUSER `logalot_app` role, so FORCE ROW
// LEVEL SECURITY actually governs every statement here.
export async function withTenantTx<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// PG_UNIQUE_VIOLATION is the SQLSTATE for a unique-constraint conflict, mapped to
// a domain ConflictError by the repositories.
export const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}
