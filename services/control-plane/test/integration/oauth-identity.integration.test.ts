import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgOAuthIdentityRepository } from '../../src/adapters/postgres/oauth-identity-repository';
import { armedQuery, type ItEnv, setupEnv, teardownEnv } from './helpers';

// Docker-backed integration suite for OAuthIdentityRepository (issue #91).
// Runs against the real logalot_app role (NOSUPERUSER) so RLS genuinely bites.
// Verifies:
//   AC-1  findByProviderSub returns the row ONLY under the matching tenant's RLS context.
//   AC-2  same (provider, sub) linked in tenant A is INVISIBLE under tenant B.
//   AC-3  unknown sub → null.
//   AC-4  first-link INSERT visible only under its tenant.
//   AC-5  multi-tenant membership: same (provider, sub) links in A AND B.
//   AC-6  duplicate (tenant_id, provider, sub) within one tenant → 23505 caught → re-resolve.

describe('OAuthIdentityRepository integration', () => {
  let env: ItEnv;
  let repo: PgOAuthIdentityRepository;

  let tenantAId: string;
  let tenantBId: string;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    env = await setupEnv();
    repo = new PgOAuthIdentityRepository(env.appPool);

    tenantAId = randomUUID();
    tenantBId = randomUUID();

    // Insert tenants + users directly as superuser (bypasses RLS — mirrors
    // seedPlatformOperator). We do NOT go through the HTTP layer here because this
    // suite probes the storage adapter in isolation.
    await env.adminPool.query(
      `INSERT INTO tenants (id, public_id, name, status) VALUES
        ($1, 'oauth-tenant-a', 'OAuth Tenant A', 'active'),
        ($2, 'oauth-tenant-b', 'OAuth Tenant B', 'active')`,
      [tenantAId, tenantBId],
    );

    const userARes = await env.adminPool.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, password_hash, display_name)
       VALUES ($1, 'alice@a.co', 'x', 'Alice')
       RETURNING id`,
      [tenantAId],
    );
    userAId = (userARes.rows[0] as { id: string }).id;

    const userBRes = await env.adminPool.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, password_hash, display_name)
       VALUES ($1, 'bob@b.co', 'x', 'Bob')
       RETURNING id`,
      [tenantBId],
    );
    userBId = (userBRes.rows[0] as { id: string }).id;
  });

  afterAll(() => teardownEnv(env));

  // AC-3: unknown sub → null.
  it('findByProviderSub returns null for an unknown sub', async () => {
    const result = await repo.findByProviderSub(tenantAId, 'google', 'unknown-sub-xyz');
    expect(result).toBeNull();
  });

  // AC-4: first-link INSERT visible only under its tenant.
  it('linkFirst inserts a row and returns {id, userId}', async () => {
    const ref = await repo.linkFirst(tenantAId, {
      userId: userAId,
      provider: 'google',
      providerSub: '1001',
      email: 'alice@a.co',
    });

    expect(ref.id).toBeTypeOf('string');
    expect(ref.userId).toBe(userAId);

    // Verify the row is visible under tenant A via armedQuery.
    const rows = await armedQuery<{ id: string }>(
      env.appPool,
      tenantAId,
      `SELECT id FROM oauth_identities WHERE provider_sub = '1001'`,
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(ref.id);
  });

  // AC-1: findByProviderSub returns the row ONLY under the matching tenant's RLS context.
  it('findByProviderSub returns ref under the correct tenant', async () => {
    const ref = await repo.findByProviderSub(tenantAId, 'google', '1001');
    expect(ref).not.toBeNull();
    expect(ref!.userId).toBe(userAId);
  });

  // AC-2: same (provider, sub) linked in tenant A is INVISIBLE under tenant B.
  it('findByProviderSub returns null for a sub linked in a different tenant', async () => {
    const refInB = await repo.findByProviderSub(tenantBId, 'google', '1001');
    expect(refInB).toBeNull();
  });

  // AC-4 (storage isolation): the row inserted in tenant A is not visible via
  // a raw armedQuery under tenant B — proving RLS bites at the Postgres layer.
  it('oauth_identities row for tenant A is invisible under tenant B RLS', async () => {
    const rows = await armedQuery<{ id: string }>(
      env.appPool,
      tenantBId,
      `SELECT id FROM oauth_identities WHERE provider_sub = '1001'`,
      [],
    );
    expect(rows).toHaveLength(0);
  });

  // AC-5: multi-tenant membership — same (provider, sub) links in tenant A AND B.
  it('linkFirst allows the same (provider, sub) to be linked in a different tenant', async () => {
    // Link the same Google account (sub '1001') to userB in tenant B.
    const refInB = await repo.linkFirst(tenantBId, {
      userId: userBId,
      provider: 'google',
      providerSub: '1001',
      email: 'alice@b.co', // different tenant, different user
    });
    expect(refInB.userId).toBe(userBId);

    // Now both tenants have a row for sub '1001'.
    const inA = await repo.findByProviderSub(tenantAId, 'google', '1001');
    const inB = await repo.findByProviderSub(tenantBId, 'google', '1001');
    expect(inA!.userId).toBe(userAId);
    expect(inB!.userId).toBe(userBId);
    // They are distinct rows.
    expect(inA!.id).not.toBe(inB!.id);
  });

  // AC-6: duplicate (tenant_id, provider, sub) within one tenant → 23505 caught
  // → re-resolve (idempotent return of the winner's ref).
  it('linkFirst is idempotent: duplicate within the same tenant returns the existing ref', async () => {
    const firstRef = await repo.findByProviderSub(tenantAId, 'google', '1001');
    expect(firstRef).not.toBeNull();

    // Attempt to link the same (provider, sub) for the same tenant again.
    const secondRef = await repo.linkFirst(tenantAId, {
      userId: userAId,
      provider: 'google',
      providerSub: '1001',
      email: 'alice@a.co',
    });

    // Must return the SAME row (no ConflictError thrown).
    expect(secondRef.id).toBe(firstRef!.id);
    expect(secondRef.userId).toBe(firstRef!.userId);
  });

  // touchLastLogin: updates last_login_at under RLS.
  it('touchLastLogin updates last_login_at and the change is visible in-tenant', async () => {
    const ref = await repo.findByProviderSub(tenantAId, 'google', '1001');
    expect(ref).not.toBeNull();

    const beforeRows = await armedQuery<{ last_login_at: Date | null }>(
      env.appPool,
      tenantAId,
      `SELECT last_login_at FROM oauth_identities WHERE id = $1`,
      [ref!.id],
    );
    expect(beforeRows[0]?.last_login_at).toBeNull();

    const loginAt = new Date('2025-01-15T10:00:00Z');
    await repo.touchLastLogin(tenantAId, ref!.id, loginAt);

    const afterRows = await armedQuery<{ last_login_at: Date | null }>(
      env.appPool,
      tenantAId,
      `SELECT last_login_at FROM oauth_identities WHERE id = $1`,
      [ref!.id],
    );
    expect(afterRows[0]?.last_login_at?.toISOString()).toBe(loginAt.toISOString());
  });

  // findById: full projection returns all columns.
  it('findById returns the full OAuthIdentity projection for an in-tenant row', async () => {
    const ref = await repo.findByProviderSub(tenantAId, 'google', '1001');
    expect(ref).not.toBeNull();

    const identity = await repo.findById(tenantAId, ref!.id);
    expect(identity).not.toBeNull();
    expect(identity!.tenantId).toBe(tenantAId);
    expect(identity!.userId).toBe(userAId);
    expect(identity!.provider).toBe('google');
    expect(identity!.providerSub).toBe('1001');
    expect(identity!.email).toBe('alice@a.co');
  });

  // findById cross-tenant: row from tenant A is NOT visible under tenant B.
  it('findById returns null when queried under a different tenant (RLS)', async () => {
    const ref = await repo.findByProviderSub(tenantAId, 'google', '1001');
    expect(ref).not.toBeNull();

    const crossTenantResult = await repo.findById(tenantBId, ref!.id);
    expect(crossTenantResult).toBeNull();
  });
});
