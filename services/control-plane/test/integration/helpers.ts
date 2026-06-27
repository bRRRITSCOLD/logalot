import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { BcryptHasher } from '../../src/adapters/crypto/bcrypt-hasher';
import { buildServer } from '../../src/adapters/http/server';
import { createPool } from '../../src/adapters/postgres/pool';
import { type Config, loadConfig } from '../../src/config/env';
import { buildContainer } from '../../src/container';

const { Pool } = pg;

const HERE = dirname(fileURLToPath(import.meta.url));
// test/integration -> services/control-plane -> services -> repo root -> migrations
const MIGRATIONS_DIR = resolve(HERE, '..', '..', '..', '..', 'migrations');

export interface ItEnv {
  pg: StartedPostgreSqlContainer;
  adminPool: pg.Pool; // postgres superuser — seeds + cross-checks (bypasses RLS)
  appPool: pg.Pool; // logalot_app (NOSUPERUSER) — RLS bites here
  app: FastifyInstance;
  config: Config;
}

// applyMigrations runs every repo *.up.sql in numeric order as the superuser owner
// (creating the schema, pgcrypto, the partitioned log table, AND the NOSUPERUSER
// logalot_app role itself). This mirrors the Go integration suite's approach so
// both stacks test against the identical schema.
async function applyMigrations(adminPool: pg.Pool): Promise<void> {
  // golang-migrate normally creates this bookkeeping table; migration 000011
  // REVOKEs a grant on it. Applying the raw .up.sql files (no migrate runner)
  // means we must create the stub first so that REVOKE succeeds.
  await adminPool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version bigint PRIMARY KEY, dirty boolean NOT NULL DEFAULT false)',
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.up.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await adminPool.query(sql);
  }
}

export async function setupEnv(): Promise<ItEnv> {
  const container = await new PostgreSqlContainer('postgres:16')
    .withDatabase('logalot')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const adminUri = `postgres://postgres:postgres@${host}:${port}/logalot`;
  const appUri = `postgres://logalot_app:logalot_app@${host}:${port}/logalot`;

  const adminPool = new Pool({ connectionString: adminUri });
  await applyMigrations(adminPool);

  const appPool = createPool(appUri);
  const config = loadConfig({
    NODE_ENV: 'test',
    LOGALOT_APP_DATABASE_URL: appUri,
    JWT_SECRET: 'integration-test-signing-secret',
    BCRYPT_COST: '4',
  } as NodeJS.ProcessEnv);

  const { services, tokenService } = buildContainer(appPool, config);
  const app = buildServer({
    services,
    tokenService,
    ping: async () => true,
    logger: false,
  });
  await app.ready();

  return { pg: container, adminPool, appPool, app, config };
}

export async function teardownEnv(env: ItEnv): Promise<void> {
  await env.app.close();
  await env.appPool.end();
  await env.adminPool.end();
  await env.pg.stop();
}

// seedPlatformOperator inserts a tenant + a platform_operator user directly via the
// superuser pool (which bypasses RLS, so no tenant context is needed). This
// bootstraps the very first operator the way an installer would.
export async function seedPlatformOperator(
  env: ItEnv,
  opts: { tenantId: string; slug: string; email: string; password: string },
): Promise<void> {
  const hasher = new BcryptHasher(4);
  const passwordHash = await hasher.hash(opts.password);
  await env.adminPool.query(
    `INSERT INTO tenants (id, public_id, name, status) VALUES ($1, $2, $3, 'active')`,
    [opts.tenantId, opts.slug, `${opts.slug} tenant`],
  );
  await env.adminPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, display_name, is_platform_operator)
     VALUES ($1, $2, $3, $4, true)`,
    [opts.tenantId, opts.email, passwordHash, 'Platform Operator'],
  );
}

// armedQuery runs a single statement on the app pool with RLS armed for a tenant —
// used by tests to prove what a given tenant CAN and CANNOT see at the storage
// layer (independently of the HTTP layer).
export async function armedQuery<T extends pg.QueryResultRow>(
  appPool: pg.Pool,
  tenantId: string,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const res = await client.query<T>(sql, params);
    await client.query('COMMIT');
    return res.rows;
  } finally {
    client.release();
  }
}
