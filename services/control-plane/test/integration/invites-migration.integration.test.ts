import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { armedQuery, type ItEnv, setupEnv, teardownEnv } from './helpers';

// Docker-backed integration suite for migration 000018_invites (issue #142).
// Runs against the real logalot_app role (NOSUPERUSER NOBYPASSRLS) so RLS
// genuinely bites and FORCE ROW LEVEL SECURITY is exercised.
//
// Acceptance criteria verified:
//   AC-1  partial unique rejects a 2nd 'pending' row for the same (tenant,email)
//         but allows one after the first is 'revoked' or 'consumed'
//   AC-2  inserting a token_hash != 32 bytes fails the CHECK constraint (R-INV-2)
//   AC-3  an unscoped (no app.tenant_id) SELECT returns zero rows (fail-closed)
//   AC-4  logalot_app (NOSUPERUSER NOBYPASSRLS) is subject to FORCE RLS
//
// Discharges: R-INV-2, R-INV-4, R-INV-5, R-INV-7/15, R-INV-10

function sha256(buf: Buffer): Buffer {
  return createHash('sha256').update(buf).digest();
}

function newTokenHash(): Buffer {
  // 32-byte sha256 of a random secret — mirrors domain/secret-hash.ts
  return sha256(randomBytes(32));
}

describe('migration 000018_invites', () => {
  let env: ItEnv;
  let tenantId: string;
  let tenantBId: string;
  let userId: string;
  const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  beforeAll(async () => {
    env = await setupEnv();

    tenantId = randomUUID();
    tenantBId = randomUUID();

    // Seed test tenants + a user via superuser (bypasses RLS).
    await env.adminPool.query(
      `INSERT INTO tenants (id, public_id, name, status) VALUES
        ($1, 'inv-test-tenant-a', 'Invite Test Tenant A', 'active'),
        ($2, 'inv-test-tenant-b', 'Invite Test Tenant B', 'active')`,
      [tenantId, tenantBId],
    );

    const userRes = await env.adminPool.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, password_hash, display_name)
       VALUES ($1, 'admin@invtest.example', 'x', 'Invite Admin')
       RETURNING id`,
      [tenantId],
    );
    userId = (userRes.rows[0] as { id: string }).id;
  });

  afterAll(() => teardownEnv(env));

  // ── Schema smoke ────────────────────────────────────────────────────────────

  it('invites table exists with expected columns', async () => {
    const res = await env.adminPool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'invites'
        ORDER BY ordinal_position`,
    );
    const cols = res.rows.map((r) => r.column_name);
    expect(cols).toContain('id');
    expect(cols).toContain('tenant_id');
    expect(cols).toContain('email');
    expect(cols).toContain('role');
    expect(cols).toContain('token_hash');
    expect(cols).toContain('status');
    expect(cols).toContain('expires_at');
    expect(cols).toContain('created_by');
    expect(cols).toContain('consumed_at');
    expect(cols).toContain('created_at');
    expect(cols).toContain('updated_at');

    // expires_at must be NOT NULL (R-INV-4 — no "never expires")
    const expiresRow = res.rows.find((r) => r.column_name === 'expires_at');
    expect(expiresRow?.is_nullable).toBe('NO');
  });

  // ── AC-2: token_hash length CHECK (R-INV-2) ─────────────────────────────────

  it('AC-2: inserting a token_hash < 32 bytes fails the CHECK constraint', async () => {
    const shortHash = Buffer.from('tooshort');
    await expect(
      env.adminPool.query(
        `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
         VALUES ($1, $2, 'member', $3, $4, $5)`,
        [tenantId, 'short@hash.example', shortHash, futureExpiry, userId],
      ),
    ).rejects.toThrow(/invites_token_hash_len/);
  });

  it('AC-2: inserting a token_hash > 32 bytes fails the CHECK constraint', async () => {
    const longHash = Buffer.alloc(64, 0xff);
    await expect(
      env.adminPool.query(
        `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
         VALUES ($1, $2, 'member', $3, $4, $5)`,
        [tenantId, 'long@hash.example', longHash, futureExpiry, userId],
      ),
    ).rejects.toThrow(/invites_token_hash_len/);
  });

  it('AC-2: inserting a valid 32-byte token_hash succeeds', async () => {
    const hash = newTokenHash();
    const res = await env.adminPool.query<{ id: string }>(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
       VALUES ($1, $2, 'member', $3, $4, $5)
       RETURNING id`,
      [tenantId, 'valid-hash@test.example', hash, futureExpiry, userId],
    );
    expect(res.rows[0]?.id).toBeTypeOf('string');
  });

  // ── AC-1: partial unique (R-INV-10) ────────────────────────────────────────

  it('AC-1: two pending invites for the same (tenant,email) violates partial unique', async () => {
    const email = 'partialuniq@test.example';
    const hash1 = newTokenHash();

    // First pending invite — succeeds.
    await env.adminPool.query(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
       VALUES ($1, $2, 'member', $3, $4, $5)`,
      [tenantId, email, hash1, futureExpiry, userId],
    );

    // Second pending invite for the SAME (tenant, email) — must fail.
    const hash2 = newTokenHash();
    await expect(
      env.adminPool.query(
        `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
         VALUES ($1, $2, 'admin', $3, $4, $5)`,
        [tenantId, email, hash2, futureExpiry, userId],
      ),
    ).rejects.toThrow(/uq_invites_pending_per_email|unique/i);
  });

  it('AC-1: a second invite is allowed after the first is revoked', async () => {
    const email = 'revoke-then-reinvite@test.example';
    const hash1 = newTokenHash();

    // Insert first pending invite.
    const res = await env.adminPool.query<{ id: string }>(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
       VALUES ($1, $2, 'member', $3, $4, $5)
       RETURNING id`,
      [tenantId, email, hash1, futureExpiry, userId],
    );
    const firstId = (res.rows[0] as { id: string }).id;

    // Revoke the first invite.
    await env.adminPool.query(`UPDATE invites SET status = 'revoked' WHERE id = $1`, [firstId]);

    // Now a new pending invite for the same (tenant, email) must succeed.
    const hash2 = newTokenHash();
    const res2 = await env.adminPool.query<{ id: string }>(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
       VALUES ($1, $2, 'admin', $3, $4, $5)
       RETURNING id`,
      [tenantId, email, hash2, futureExpiry, userId],
    );
    expect(res2.rows[0]?.id).toBeTypeOf('string');
    expect(res2.rows[0]?.id).not.toBe(firstId);
  });

  it('AC-1: a second invite is allowed after the first is consumed', async () => {
    const email = 'consume-then-reinvite@test.example';
    const hash1 = newTokenHash();

    const res = await env.adminPool.query<{ id: string }>(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
       VALUES ($1, $2, 'member', $3, $4, $5)
       RETURNING id`,
      [tenantId, email, hash1, futureExpiry, userId],
    );
    const firstId = (res.rows[0] as { id: string }).id;

    // Consume the first invite.
    await env.adminPool.query(
      `UPDATE invites SET status = 'consumed', consumed_at = now() WHERE id = $1`,
      [firstId],
    );

    // New pending invite must succeed.
    const hash2 = newTokenHash();
    const res2 = await env.adminPool.query<{ id: string }>(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
       VALUES ($1, $2, 'member', $3, $4, $5)
       RETURNING id`,
      [tenantId, email, hash2, futureExpiry, userId],
    );
    expect(res2.rows[0]?.id).toBeTypeOf('string');
    expect(res2.rows[0]?.id).not.toBe(firstId);
  });

  // ── AC-3: RLS fail-closed (R-INV-7/15) ─────────────────────────────────────

  it('AC-3: an unscoped SELECT (no app.tenant_id) returns zero rows', async () => {
    // Insert a row as superuser to ensure there is at least one row in the table.
    const hash = newTokenHash();
    await env.adminPool.query(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
       VALUES ($1, $2, 'member', $3, $4, $5)`,
      [tenantId, 'rls-check@test.example', hash, futureExpiry, userId],
    );

    // Query via appPool WITHOUT setting app.tenant_id — must see zero rows.
    const res = await env.appPool.query('SELECT id FROM invites');
    expect(res.rows).toHaveLength(0);
  });

  // ── AC-4: logalot_app (NOSUPERUSER NOBYPASSRLS) is subject to FORCE RLS ────

  it('AC-4: logalot_app sees only rows for the armed tenant', async () => {
    const emailA = 'force-rls-tenant-a@test.example';
    const emailB = 'force-rls-tenant-b@test.example';

    // Insert a user for tenant B to satisfy the FK.
    const userBRes = await env.adminPool.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, password_hash, display_name)
       VALUES ($1, 'adminb@invtest.example', 'x', 'Invite Admin B')
       RETURNING id`,
      [tenantBId],
    );
    const userBId = (userBRes.rows[0] as { id: string }).id;

    // Insert one invite per tenant as superuser.
    const hashA = newTokenHash();
    const hashB = newTokenHash();
    await env.adminPool.query(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
       VALUES ($1, $2, 'member', $3, $4, $5)`,
      [tenantId, emailA, hashA, futureExpiry, userId],
    );
    await env.adminPool.query(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
       VALUES ($1, $2, 'member', $3, $4, $5)`,
      [tenantBId, emailB, hashB, futureExpiry, userBId],
    );

    // logalot_app armed as tenant A — sees tenant A invite, NOT tenant B.
    const rowsA = await armedQuery<{ email: string }>(
      env.appPool,
      tenantId,
      `SELECT email FROM invites WHERE email IN ($1, $2)`,
      [emailA, emailB],
    );
    const emailsA = rowsA.map((r) => r.email);
    expect(emailsA).toContain(emailA);
    expect(emailsA).not.toContain(emailB);

    // logalot_app armed as tenant B — sees tenant B invite, NOT tenant A.
    const rowsB = await armedQuery<{ email: string }>(
      env.appPool,
      tenantBId,
      `SELECT email FROM invites WHERE email IN ($1, $2)`,
      [emailA, emailB],
    );
    const emailsB = rowsB.map((r) => r.email);
    expect(emailsB).toContain(emailB);
    expect(emailsB).not.toContain(emailA);
  });

  // ── Status CHECK constraint (R-INV-5) ────────────────────────────────────────

  it('R-INV-5: inserting an invalid status fails the CHECK constraint', async () => {
    const hash = newTokenHash();
    await expect(
      env.adminPool.query(
        `INSERT INTO invites (tenant_id, email, role, token_hash, status, expires_at, created_by)
         VALUES ($1, $2, 'member', $3, 'active', $4, $5)`,
        [tenantId, 'bad-status@test.example', hash, futureExpiry, userId],
      ),
    ).rejects.toThrow(/check/i);
  });

  it('R-INV-5: inserting an invalid role fails the CHECK constraint', async () => {
    const hash = newTokenHash();
    await expect(
      env.adminPool.query(
        `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
         VALUES ($1, $2, 'tenant_admin', $3, $4, $5)`,
        [tenantId, 'bad-role@test.example', hash, futureExpiry, userId],
      ),
    ).rejects.toThrow(/check/i);
  });

  // ── R-INV-4: expires_at NOT NULL ─────────────────────────────────────────────

  it('R-INV-4: inserting without expires_at fails NOT NULL constraint', async () => {
    const hash = newTokenHash();
    await expect(
      env.adminPool.query(
        `INSERT INTO invites (tenant_id, email, role, token_hash, created_by)
         VALUES ($1, $2, 'member', $3, $4)`,
        [tenantId, 'no-expiry@test.example', hash, userId],
      ),
    ).rejects.toThrow(/null value.*expires_at|not-null constraint/i);
  });

  // ── updated_at trigger ───────────────────────────────────────────────────────

  it('trg_invites_updated: updated_at advances on UPDATE', async () => {
    const hash = newTokenHash();
    const insertRes = await env.adminPool.query<{ id: string; updated_at: Date }>(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
       VALUES ($1, $2, 'member', $3, $4, $5)
       RETURNING id, updated_at`,
      [tenantId, 'trigger-test@test.example', hash, futureExpiry, userId],
    );
    const { id, updated_at: before } = insertRes.rows[0] as { id: string; updated_at: Date };

    // Wait 1ms to ensure the clock ticks.
    await new Promise((r) => setTimeout(r, 5));

    await env.adminPool.query(`UPDATE invites SET status = 'revoked' WHERE id = $1`, [id]);

    const selectRes = await env.adminPool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM invites WHERE id = $1`,
      [id],
    );
    const after = (selectRes.rows[0] as { updated_at: Date }).updated_at;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});
