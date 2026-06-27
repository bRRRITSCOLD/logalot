import pg from 'pg';

const { Pool } = pg;

// createPool builds the pg connection pool. Services MUST connect as the
// NOSUPERUSER, non-BYPASSRLS `logalot_app` role (LOGALOT_APP_DATABASE_URL) — that
// is what makes FORCE ROW LEVEL SECURITY bite. Connecting as the owner/superuser
// would silently bypass the tenant backstop (model.md §4.2, migration 000011).
export function createPool(connectionString: string): pg.Pool {
  return new Pool({ connectionString });
}
