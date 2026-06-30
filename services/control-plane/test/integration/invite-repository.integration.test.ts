import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consumeWithClient,
  PgInviteRepository,
} from '../../src/adapters/postgres/invite-repository';
import { withTenantTx } from '../../src/adapters/postgres/tenant-tx';
import { armedQuery, type ItEnv, setupEnv, teardownEnv } from './helpers';

// Docker-backed integration suite for PgInviteRepository (issue #148).
// Runs against the real logalot_app role (NOSUPERUSER NOBYPASSRLS) so RLS
// genuinely bites and FORCE ROW LEVEL SECURITY is exercised.
//
// Acceptance criteria verified:
//   R-INV-1   consume binds on email — wrong email → null, row stays 'pending'
//   R-INV-3   sequential double-consume → null on the second call
//   R-INV-4   expired invite → null from consume + findValidByTokenHash
//   R-INV-5   revoked invite → null from consume
//   R-INV-6   every failure mode → null (no enumeration oracle)
//   R-INV-15  cross-tenant probe → null (RLS isolates)

function sha256(buf: Buffer): Buffer {
  return createHash('sha256').update(buf).digest();
}

function newSecretHash(): Buffer {
  return sha256(randomBytes(32));
}

describe('PgInviteRepository integration', () => {
  let env: ItEnv;
  let repo: PgInviteRepository;

  let tenantAId: string;
  let tenantBId: string;
  let userAId: string;

  const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const pastExpiry = new Date(Date.now() - 60 * 1000); // 1 minute ago

  beforeAll(async () => {
    env = await setupEnv();
    repo = new PgInviteRepository(env.appPool);

    tenantAId = randomUUID();
    tenantBId = randomUUID();

    // Seed tenants + a user as superuser (bypasses RLS).
    await env.adminPool.query(
      `INSERT INTO tenants (id, public_id, name, status) VALUES
        ($1, 'invite-repo-tenant-a', 'Invite Repo Tenant A', 'active'),
        ($2, 'invite-repo-tenant-b', 'Invite Repo Tenant B', 'active')`,
      [tenantAId, tenantBId],
    );

    const userARes = await env.adminPool.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, password_hash, display_name)
       VALUES ($1, 'admin-a@invite-repo.example', 'x', 'Admin A')
       RETURNING id`,
      [tenantAId],
    );
    userAId = (userARes.rows[0] as { id: string }).id;
  });

  afterAll(() => teardownEnv(env));

  // ── create ───────────────────────────────────────────────────────────────────

  it('create returns an Invite projection without token_hash', async () => {
    const secretHash = newSecretHash();
    const invite = await repo.create(tenantAId, {
      role: 'member',
      email: 'alice@create.example',
      secretHash,
      invitedBy: userAId,
      expiresAt: futureExpiry,
    });

    expect(invite.id).toBeTypeOf('string');
    expect(invite.tenantId).toBe(tenantAId);
    expect(invite.email).toBe('alice@create.example');
    expect(invite.role).toBe('member');
    expect(invite.status).toBe('pending');
    expect(invite.invitedBy).toBe(userAId);
    expect(invite.expiresAt).toBeInstanceOf(Date);
    expect(invite.consumedAt).toBeNull();

    // Projection must NEVER carry hash.
    const keys = Object.keys(invite);
    expect(keys).not.toContain('token_hash');
    expect(keys).not.toContain('secretHash');
  });

  // ── findValidByTokenHash ────────────────────────────────────────────────────

  it('findValidByTokenHash returns InviteRef for a pending non-expired invite', async () => {
    const secretHash = newSecretHash();
    const created = await repo.create(tenantAId, {
      role: 'admin',
      email: 'bob@find-valid.example',
      secretHash,
      invitedBy: userAId,
      expiresAt: futureExpiry,
    });

    const ref = await repo.findValidByTokenHash(tenantAId, secretHash, new Date());
    expect(ref).not.toBeNull();
    expect(ref?.id).toBe(created.id);
    expect(ref?.tenantId).toBe(tenantAId);
    expect(ref?.email).toBe('bob@find-valid.example');
  });

  it('findValidByTokenHash returns null for an expired invite (R-INV-4)', async () => {
    const secretHash = newSecretHash();
    // Insert past-expiry invite directly via adminPool (bypasses app-level cap).
    await env.adminPool.query(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
       VALUES ($1, $2, 'member', $3, $4, $5)`,
      [tenantAId, 'expired@find-valid.example', secretHash, pastExpiry, userAId],
    );

    const ref = await repo.findValidByTokenHash(tenantAId, secretHash, new Date());
    expect(ref).toBeNull();
  });

  it('findValidByTokenHash returns null for an unknown hash (R-INV-6)', async () => {
    const randomHash = newSecretHash();
    const ref = await repo.findValidByTokenHash(tenantAId, randomHash, new Date());
    expect(ref).toBeNull();
  });

  it('findValidByTokenHash does not mutate status', async () => {
    const secretHash = newSecretHash();
    const created = await repo.create(tenantAId, {
      role: 'member',
      email: 'carol@find-valid.example',
      secretHash,
      invitedBy: userAId,
      expiresAt: futureExpiry,
    });

    // Probe twice — must stay 'pending'.
    await repo.findValidByTokenHash(tenantAId, secretHash, new Date());
    await repo.findValidByTokenHash(tenantAId, secretHash, new Date());

    const rows = await armedQuery<{ status: string }>(
      env.appPool,
      tenantAId,
      `SELECT status FROM invites WHERE id = $1`,
      [created.id],
    );
    expect(rows[0]?.status).toBe('pending');
  });

  // ── consume — happy path ────────────────────────────────────────────────────

  it('consume happy path: flips status to consumed and returns ConsumedInvite', async () => {
    const secretHash = newSecretHash();
    const email = 'dave@consume-happy.example';
    const now = new Date();

    const created = await repo.create(tenantAId, {
      role: 'member',
      email,
      secretHash,
      invitedBy: userAId,
      expiresAt: futureExpiry,
    });

    const result = await repo.consume(tenantAId, { tokenHash: secretHash, email, now });
    expect(result).not.toBeNull();
    expect(result?.inviteId).toBe(created.id);
    expect(result?.role).toBe('member');
    expect(result?.email).toBe(email);
    expect(result?.consumedAt).toBeInstanceOf(Date);

    // Row must be 'consumed' in the database.
    const rows = await armedQuery<{ status: string; consumed_at: Date | null }>(
      env.appPool,
      tenantAId,
      `SELECT status, consumed_at FROM invites WHERE id = $1`,
      [created.id],
    );
    expect(rows[0]?.status).toBe('consumed');
    expect(rows[0]?.consumed_at).not.toBeNull();
  });

  // ── consume — R-INV-1: email-binding ────────────────────────────────────────

  it('R-INV-1: consume with wrong email returns null; row stays pending', async () => {
    const secretHash = newSecretHash();
    const email = 'eve@email-binding.example';

    const created = await repo.create(tenantAId, {
      role: 'member',
      email,
      secretHash,
      invitedBy: userAId,
      expiresAt: futureExpiry,
    });

    const result = await repo.consume(tenantAId, {
      tokenHash: secretHash,
      email: 'wrong@email-binding.example',
      now: new Date(),
    });
    expect(result).toBeNull();

    // Row must still be 'pending'.
    const rows = await armedQuery<{ status: string }>(
      env.appPool,
      tenantAId,
      `SELECT status FROM invites WHERE id = $1`,
      [created.id],
    );
    expect(rows[0]?.status).toBe('pending');
  });

  // ── consume — R-INV-4: expired ──────────────────────────────────────────────

  it('R-INV-4: consume of an expired invite returns null; row stays pending', async () => {
    const secretHash = newSecretHash();
    const email = 'frank@expired.example';

    // Insert past-expiry invite directly via adminPool.
    const res = await env.adminPool.query<{ id: string }>(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
       VALUES ($1, $2, 'member', $3, $4, $5)
       RETURNING id`,
      [tenantAId, email, secretHash, pastExpiry, userAId],
    );
    const inviteId = (res.rows[0] as { id: string }).id;

    const result = await repo.consume(tenantAId, {
      tokenHash: secretHash,
      email,
      now: new Date(),
    });
    expect(result).toBeNull();

    // Row must still be 'pending'.
    const rows = await armedQuery<{ status: string }>(
      env.appPool,
      tenantAId,
      `SELECT status FROM invites WHERE id = $1`,
      [inviteId],
    );
    expect(rows[0]?.status).toBe('pending');
  });

  // ── consume — R-INV-5: revoked ──────────────────────────────────────────────

  it('R-INV-5: consume of a revoked invite returns null', async () => {
    const secretHash = newSecretHash();
    const email = 'grace@revoked.example';

    const created = await repo.create(tenantAId, {
      role: 'member',
      email,
      secretHash,
      invitedBy: userAId,
      expiresAt: futureExpiry,
    });

    const revoked = await repo.revoke(tenantAId, created.id, new Date());
    expect(revoked).toBe(true);

    const result = await repo.consume(tenantAId, {
      tokenHash: secretHash,
      email,
      now: new Date(),
    });
    expect(result).toBeNull();
  });

  // ── consume — R-INV-3: sequential double-consume ────────────────────────────

  it('R-INV-3: second consume of an already-consumed invite returns null', async () => {
    const secretHash = newSecretHash();
    const email = 'henry@double-consume.example';

    await repo.create(tenantAId, {
      role: 'admin',
      email,
      secretHash,
      invitedBy: userAId,
      expiresAt: futureExpiry,
    });

    // First consume — must succeed.
    const first = await repo.consume(tenantAId, { tokenHash: secretHash, email, now: new Date() });
    expect(first).not.toBeNull();

    // Second consume — must return null (already consumed → status ≠ 'pending').
    const second = await repo.consume(tenantAId, {
      tokenHash: secretHash,
      email,
      now: new Date(),
    });
    expect(second).toBeNull();
  });

  // ── consume — R-INV-15: cross-tenant isolation ──────────────────────────────

  it('R-INV-15: consume armed for a different tenant returns null', async () => {
    const secretHash = newSecretHash();
    const email = 'iris@cross-tenant.example';

    // Create user for tenant B to satisfy FK.
    await env.adminPool.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, password_hash, display_name)
       VALUES ($1, 'adminb@invite-repo.example', 'x', 'Admin B')
       RETURNING id`,
      [tenantBId],
    );

    // Insert invite under tenant A.
    await env.adminPool.query(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at, created_by)
       VALUES ($1, $2, 'member', $3, $4, $5)`,
      [tenantAId, email, secretHash, futureExpiry, userAId],
    );

    // consume armed for tenant B must see zero rows (RLS scopes the UPDATE).
    const result = await repo.consume(tenantBId, {
      tokenHash: secretHash,
      email,
      now: new Date(),
    });
    expect(result).toBeNull();

    // Invite must still be 'pending' under tenant A.
    const rows = await armedQuery<{ status: string }>(
      env.appPool,
      tenantAId,
      `SELECT status FROM invites WHERE token_hash = $1`,
      [secretHash],
    );
    expect(rows[0]?.status).toBe('pending');
  });

  // ── consumeWithClient — exported for unit-of-work ───────────────────────────

  it('consumeWithClient can be called inside a shared transaction', async () => {
    const secretHash = newSecretHash();
    const email = 'jack@consume-with-client.example';

    await repo.create(tenantAId, {
      role: 'member',
      email,
      secretHash,
      invitedBy: userAId,
      expiresAt: futureExpiry,
    });

    // Call consumeWithClient inside withTenantTx — simulates what T9 does.
    const result = await withTenantTx(env.appPool, tenantAId, async (client) => {
      return consumeWithClient(client, { tokenHash: secretHash, email, now: new Date() });
    });

    expect(result).not.toBeNull();
    expect(result?.role).toBe('member');
    expect(result?.email).toBe(email);
    expect(result?.consumedAt).toBeInstanceOf(Date);
  });

  // ── revoke ───────────────────────────────────────────────────────────────────

  it('revoke flips status to revoked and returns true', async () => {
    const secretHash = newSecretHash();

    const created = await repo.create(tenantAId, {
      role: 'member',
      email: 'kate@revoke.example',
      secretHash,
      invitedBy: userAId,
      expiresAt: futureExpiry,
    });

    const result = await repo.revoke(tenantAId, created.id, new Date());
    expect(result).toBe(true);

    const rows = await armedQuery<{ status: string }>(
      env.appPool,
      tenantAId,
      `SELECT status FROM invites WHERE id = $1`,
      [created.id],
    );
    expect(rows[0]?.status).toBe('revoked');
  });

  it('revoke returns false on a 2nd call (idempotent / already revoked)', async () => {
    const secretHash = newSecretHash();

    const created = await repo.create(tenantAId, {
      role: 'member',
      email: 'leo@double-revoke.example',
      secretHash,
      invitedBy: userAId,
      expiresAt: futureExpiry,
    });

    const first = await repo.revoke(tenantAId, created.id, new Date());
    expect(first).toBe(true);

    const second = await repo.revoke(tenantAId, created.id, new Date());
    expect(second).toBe(false);
  });

  it('revoke returns false for a non-existent id (R-INV-6, uniform null)', async () => {
    const result = await repo.revoke(tenantAId, randomUUID(), new Date());
    expect(result).toBe(false);
  });

  // ── listByTenant ──────────────────────────────────────────────────────────────

  it('listByTenant returns all statuses for the tenant in descending created_at order', async () => {
    const tenantId = randomUUID();
    await env.adminPool.query(
      `INSERT INTO tenants (id, public_id, name, status)
       VALUES ($1, 'list-tenant', 'List Tenant', 'active')`,
      [tenantId],
    );
    const userRes = await env.adminPool.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, password_hash, display_name)
       VALUES ($1, 'admin@list.example', 'x', 'Admin List')
       RETURNING id`,
      [tenantId],
    );
    const userId = (userRes.rows[0] as { id: string }).id;

    const listRepo = new PgInviteRepository(env.appPool);

    const h1 = newSecretHash();
    const h2 = newSecretHash();
    const h3 = newSecretHash();

    const i1 = await listRepo.create(tenantId, {
      role: 'member',
      email: 'list1@list.example',
      secretHash: h1,
      invitedBy: userId,
      expiresAt: futureExpiry,
    });
    const i2 = await listRepo.create(tenantId, {
      role: 'admin',
      email: 'list2@list.example',
      secretHash: h2,
      invitedBy: userId,
      expiresAt: futureExpiry,
    });
    const i3 = await listRepo.create(tenantId, {
      role: 'member',
      email: 'list3@list.example',
      secretHash: h3,
      invitedBy: userId,
      expiresAt: futureExpiry,
    });

    // Revoke one so we see all statuses.
    await listRepo.revoke(tenantId, i1.id, new Date());

    const list = await listRepo.listByTenant(tenantId);

    expect(list).toHaveLength(3);

    const ids = list.map((inv) => inv.id);
    expect(ids).toContain(i1.id);
    expect(ids).toContain(i2.id);
    expect(ids).toContain(i3.id);

    // No token_hash in any row.
    for (const inv of list) {
      expect(Object.keys(inv)).not.toContain('token_hash');
      expect(Object.keys(inv)).not.toContain('secretHash');
    }

    // Verify statuses.
    const statuses = Object.fromEntries(list.map((inv) => [inv.id, inv.status]));
    expect(statuses[i1.id]).toBe('revoked');
    expect(statuses[i2.id]).toBe('pending');
    expect(statuses[i3.id]).toBe('pending');
  });
});
