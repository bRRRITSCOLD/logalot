import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linkFirstWithClient } from '../../src/adapters/postgres/oauth-identity-repository';
import { withTenantTx } from '../../src/adapters/postgres/tenant-tx';
import { insertUserWithMembership } from '../../src/adapters/postgres/user-repository';
import { ConflictError } from '../../src/domain/errors';
import { armedQuery, type ItEnv, setupEnv, teardownEnv } from './helpers';

// Integration suite for the tx-scoped UoW seam (issue #147).
// Proves that insertUserWithMembership + linkFirstWithClient can be composed
// in a SINGLE withTenantTx call — the structural prerequisite for R-INV-17
// (atomic provisioning).
//
// AC-1: user + membership + identity all land in one tx.
// AC-2: linkFirstWithClient raises ConflictError for a different-sub (R13 path).

describe('provision-tx seam integration', () => {
  let env: ItEnv;
  let tenantId: string;

  beforeAll(async () => {
    env = await setupEnv();

    tenantId = randomUUID();
    await env.adminPool.query(
      `INSERT INTO tenants (id, public_id, name, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, 'provision-tx-tenant', 'Provision Tx Tenant'],
    );
  });

  afterAll(() => teardownEnv(env));

  // AC-1: user + membership + identity all land in ONE transaction via the extracted helpers.
  it('composes insertUserWithMembership + linkFirstWithClient in a single withTenantTx', async () => {
    const providerSub = `sub-${randomUUID()}`;
    const email = `user-${randomUUID()}@example.com`;

    const { user, identityRef } = await withTenantTx(env.appPool, tenantId, async (client) => {
      const createdUser = await insertUserWithMembership(client, tenantId, {
        email,
        passwordHash: 'hashed-password',
        displayName: 'Test User',
        role: 'member',
      });

      const ref = await linkFirstWithClient(client, tenantId, {
        userId: createdUser.id,
        provider: 'google',
        providerSub,
        email,
      });

      return { user: createdUser, identityRef: ref };
    });

    // User row landed with correct fields.
    expect(user.id).toBeTypeOf('string');
    expect(user.tenantId).toBe(tenantId);
    expect(user.email).toBe(email);
    expect(user.role).toBe('member');

    // Identity row landed and references the same user.
    expect(identityRef.id).toBeTypeOf('string');
    expect(identityRef.userId).toBe(user.id);

    // Both rows are visible under the tenant's RLS context.
    const userRows = await armedQuery<{ id: string }>(
      env.appPool,
      tenantId,
      `SELECT id FROM users WHERE id = $1`,
      [user.id],
    );
    expect(userRows).toHaveLength(1);

    const membershipRows = await armedQuery<{ role: string }>(
      env.appPool,
      tenantId,
      `SELECT role FROM memberships WHERE user_id = $1`,
      [user.id],
    );
    expect(membershipRows).toHaveLength(1);
    expect(membershipRows[0]?.role).toBe('member');

    const identityRows = await armedQuery<{ id: string; provider_sub: string }>(
      env.appPool,
      tenantId,
      `SELECT id, provider_sub FROM oauth_identities WHERE user_id = $1`,
      [user.id],
    );
    expect(identityRows).toHaveLength(1);
    expect(identityRows[0]?.provider_sub).toBe(providerSub);
  });

  // AC-2: linkFirstWithClient surfaces ConflictError for a different-sub (R13 / R-INV-17).
  // The provisioner must be able to catch this and roll back the enclosing transaction.
  it('linkFirstWithClient raises ConflictError when user already linked to a different sub', async () => {
    const email = `pinned-${randomUUID()}@example.com`;
    const firstSub = `sub-first-${randomUUID()}`;
    const secondSub = `sub-second-${randomUUID()}`;

    // Seed a user and link them to a first sub; return the user id from the tx.
    const seededUserId = await withTenantTx(env.appPool, tenantId, async (client) => {
      const createdUser = await insertUserWithMembership(client, tenantId, {
        email,
        passwordHash: 'hashed-password',
        displayName: 'Pinned User',
        role: 'member',
      });

      await linkFirstWithClient(client, tenantId, {
        userId: createdUser.id,
        provider: 'google',
        providerSub: firstSub,
        email,
      });

      return createdUser.id;
    });

    // Now try to link the same user to a DIFFERENT sub — must throw ConflictError.
    await expect(
      withTenantTx(env.appPool, tenantId, (client) =>
        linkFirstWithClient(client, tenantId, {
          userId: seededUserId,
          provider: 'google',
          providerSub: secondSub,
          email,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    // Original sub-pin stands: still exactly one identity row for the user.
    const rows = await armedQuery<{ provider_sub: string }>(
      env.appPool,
      tenantId,
      `SELECT provider_sub FROM oauth_identities WHERE user_id = $1`,
      [seededUserId],
    );
    expect(rows.map((r) => r.provider_sub)).toEqual([firstSub]);
  });
});
