import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgInviteProvisioner } from '../../src/adapters/postgres/pg-invite-provisioner';
import type { OAuthAuditEvent, OAuthAuditLogger } from '../../src/app/ports';
import { armedQuery, type ItEnv, setupEnv, teardownEnv } from './helpers';

// Docker-backed integration suite for PgInviteProvisioner (issue #149).
// Runs against the real logalot_app role (NOSUPERUSER NOBYPASSRLS) so RLS
// genuinely bites. Exercises the single tenant-armed unit-of-work that must
// commit all four writes together or not at all (R-INV-17).
//
// Acceptance criteria:
//   R-INV-1  / R-INV-8  happy path → user+membership(role)+identity committed, invite consumed,
//                                     membership role = translated invite role.
//   R-INV-17             injected step-2 failure → invite stays 'pending', zero orphan rows.
//   R-INV-17 / R13       injected R13 different-sub conflict → null, invite not consumed.
//   R-INV-3              two concurrent provisionFromInvite → exactly one success, one null,
//                         one user, one membership.
//   R-INV-8              admin invite → membership 'tenant_admin'.

function sha256(buf: Buffer): Buffer {
  return createHash('sha256').update(buf).digest();
}

function newSecretHash(): Buffer {
  return sha256(randomBytes(32));
}

// CapturingAuditLogger records emitted OAuthAuditEvents for assertion in tests.
class CapturingAuditLogger implements OAuthAuditLogger {
  readonly events: OAuthAuditEvent[] = [];
  log(event: OAuthAuditEvent): void {
    this.events.push(event);
  }
}

describe('PgInviteProvisioner integration', () => {
  let env: ItEnv;
  let tenantId: string;
  let adminUserId: string;

  const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    env = await setupEnv();

    tenantId = randomUUID();

    // Seed tenant + an admin user as superuser (bypasses RLS — mirrors
    // seedPlatformOperator in helpers.ts). We do NOT go through the HTTP layer
    // because this suite probes the storage adapter in isolation.
    await env.adminPool.query(
      `INSERT INTO tenants (id, public_id, name, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, `inv-prov-${randomUUID().slice(0, 8)}`, 'Invite Provisioner Tenant'],
    );

    const userRes = await env.adminPool.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, password_hash, display_name)
       VALUES ($1, 'admin@inv-prov.example', 'x', 'Admin')
       RETURNING id`,
      [tenantId],
    );
    adminUserId = (userRes.rows[0] as { id: string }).id;

    await env.adminPool.query(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'tenant_admin')`,
      [tenantId, adminUserId],
    );
  });

  afterAll(() => teardownEnv(env));

  // Helper: seed a pending invite via the admin pool (bypasses RLS).
  async function seedInvite(opts: { email: string; role?: string; expiresAt?: Date }) {
    const secretHash = newSecretHash();
    const res = await env.adminPool.query<{ id: string }>(
      `INSERT INTO invites (tenant_id, email, role, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        tenantId,
        opts.email,
        opts.role ?? 'member',
        secretHash,
        adminUserId,
        opts.expiresAt ?? futureExpiry,
      ],
    );
    return { id: (res.rows[0] as { id: string }).id, secretHash };
  }

  // Helper: check invite status via admin pool (bypasses RLS).
  async function getInviteStatus(inviteId: string): Promise<string> {
    const res = await env.adminPool.query<{ status: string }>(
      `SELECT status FROM invites WHERE id = $1`,
      [inviteId],
    );
    return (res.rows[0] as { status: string }).status;
  }

  // ── AC: happy path → all writes commit, invite consumed, audit emitted ────

  it('provisions user+membership+identity in one tx and returns { userId } (R-INV-1 / R-INV-8)', async () => {
    const email = `alice-${randomUUID()}@inv-prov.example`;
    const providerSub = `sub-${randomUUID()}`;
    const { id: inviteId, secretHash } = await seedInvite({ email, role: 'member' });
    const auditLogger = new CapturingAuditLogger();
    const provisioner = new PgInviteProvisioner({ pool: env.appPool, auditLogger });

    const result = await provisioner.provisionFromInvite(tenantId, {
      email,
      inviteTokenHash: secretHash,
      providerSub,
      now: new Date(),
    });

    // Returns { userId } — not null.
    expect(result).not.toBeNull();
    const userId = (result as { userId: string }).userId;
    expect(userId).toBeTypeOf('string');

    // User row exists under tenant RLS.
    const users = await armedQuery<{ email: string }>(
      env.appPool,
      tenantId,
      `SELECT email FROM users WHERE id = $1`,
      [userId],
    );
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe(email);

    // Membership row has role 'member' (translated from invite role).
    const memberships = await armedQuery<{ role: string }>(
      env.appPool,
      tenantId,
      `SELECT role FROM memberships WHERE user_id = $1`,
      [userId],
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe('member');

    // OAuth identity row linked to the new user.
    const identities = await armedQuery<{ provider_sub: string }>(
      env.appPool,
      tenantId,
      `SELECT provider_sub FROM oauth_identities WHERE user_id = $1`,
      [userId],
    );
    expect(identities).toHaveLength(1);
    expect(identities[0]?.provider_sub).toBe(providerSub);

    // Invite status is 'consumed'.
    expect(await getInviteStatus(inviteId)).toBe('consumed');

    // Audit event was emitted with outcome 'invite_provisioned'.
    expect(auditLogger.events).toHaveLength(1);
    const auditEvent = auditLogger.events[0] as OAuthAuditEvent;
    expect(auditEvent.outcome).toBe('invite_provisioned');
    expect(auditEvent.tenantId).toBe(tenantId);
    expect(auditEvent.userId).toBe(userId);
    expect(auditEvent.provider).toBe('google');
    // Raw sub must NOT be in the audit event — only the hashed value.
    expect(auditEvent.hashedSub).toBeTypeOf('string');
    expect(auditEvent.hashedSub).toHaveLength(64); // SHA-256 hex = 32 bytes = 64 hex chars
    expect(auditEvent.hashedSub).not.toBe(providerSub);
  });

  // ── AC: admin invite → membership 'tenant_admin' (R-INV-8 role translation) ─

  it('translates admin invite role to tenant_admin membership (R-INV-8)', async () => {
    const email = `admin-invitee-${randomUUID()}@inv-prov.example`;
    const providerSub = `sub-admin-${randomUUID()}`;
    const { secretHash } = await seedInvite({ email, role: 'admin' });
    const provisioner = new PgInviteProvisioner({ pool: env.appPool });

    const result = await provisioner.provisionFromInvite(tenantId, {
      email,
      inviteTokenHash: secretHash,
      providerSub,
      now: new Date(),
    });

    expect(result).not.toBeNull();
    const userId = (result as { userId: string }).userId;

    const memberships = await armedQuery<{ role: string }>(
      env.appPool,
      tenantId,
      `SELECT role FROM memberships WHERE user_id = $1`,
      [userId],
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe('tenant_admin');
  });

  // ── AC: step-2 failure → invite stays 'pending', zero orphan rows (R-INV-17) ─
  // Injected by pre-inserting a user with the same email so insertUserWithMembership
  // hits a unique violation (ConflictError). The entire tx rolls back.

  it('rolls back on membership-insert failure — invite stays pending, zero orphan rows (R-INV-17)', async () => {
    const email = `conflict-user-${randomUUID()}@inv-prov.example`;
    const providerSub = `sub-conflict-${randomUUID()}`;
    const { id: inviteId, secretHash } = await seedInvite({ email, role: 'member' });

    // Pre-insert a user with the same email to trigger a ConflictError at step 2.
    await env.adminPool.query(
      `INSERT INTO users (tenant_id, email, password_hash, display_name)
       VALUES ($1, $2, 'x', 'Pre-existing User')`,
      [tenantId, email],
    );

    const provisioner = new PgInviteProvisioner({ pool: env.appPool });
    const result = await provisioner.provisionFromInvite(tenantId, {
      email,
      inviteTokenHash: secretHash,
      providerSub,
      now: new Date(),
    });

    // Returns null — not a thrown error.
    expect(result).toBeNull();

    // Invite reverted to 'pending' (transaction rolled back).
    expect(await getInviteStatus(inviteId)).toBe('pending');

    // Zero OAuth identity rows for the providerSub (no orphan rows).
    const identities = await armedQuery<{ id: string }>(
      env.appPool,
      tenantId,
      `SELECT id FROM oauth_identities WHERE provider_sub = $1`,
      [providerSub],
    );
    expect(identities).toHaveLength(0);
  });

  // ── AC: R13 different-sub conflict → null, invite not consumed (R-INV-17 / R13)
  // A second provisioning attempt for the same email (with a new invite, since the
  // first is consumed) collapses to null because the email is already taken —
  // insertUserWithMembership hits a ConflictError, rolling back the tx.

  it('returns null on second invite for an existing email and leaves second invite pending (R-INV-17)', async () => {
    const email = `r13-user-${randomUUID()}@inv-prov.example`;
    const firstSub = `sub-first-${randomUUID()}`;
    const secondSub = `sub-second-${randomUUID()}`;
    const { secretHash } = await seedInvite({ email, role: 'member' });

    // First provisionFromInvite succeeds — links firstSub.
    const provisioner = new PgInviteProvisioner({ pool: env.appPool });
    const firstResult = await provisioner.provisionFromInvite(tenantId, {
      email,
      inviteTokenHash: secretHash,
      providerSub: firstSub,
      now: new Date(),
    });
    expect(firstResult).not.toBeNull();
    const userId = (firstResult as { userId: string }).userId;

    // Seed a SECOND invite for the same email (the first is now consumed).
    const { id: secondInviteId, secretHash: secondSecretHash } = await seedInvite({
      email,
      role: 'member',
    });

    // Second provisionFromInvite with a DIFFERENT sub for the SAME email.
    // insertUserWithMembership hits a unique violation on email → ConflictError
    // → tx rolls back, second invite stays 'pending', result is null.
    const conflictResult = await provisioner.provisionFromInvite(tenantId, {
      email,
      inviteTokenHash: secondSecretHash,
      providerSub: secondSub,
      now: new Date(),
    });

    // Returns null — not thrown.
    expect(conflictResult).toBeNull();

    // Second invite reverted to 'pending'.
    expect(await getInviteStatus(secondInviteId)).toBe('pending');

    // The existing user's identity still points to the FIRST sub only.
    const identities = await armedQuery<{ provider_sub: string }>(
      env.appPool,
      tenantId,
      `SELECT provider_sub FROM oauth_identities WHERE user_id = $1`,
      [userId],
    );
    expect(identities.map((r) => r.provider_sub)).toEqual([firstSub]);
  });

  // ── AC: two concurrent provisionFromInvite → one success, one null, one user (R-INV-3 race)

  it('concurrent provisioning for the same invite produces exactly one user (R-INV-3)', async () => {
    const email = `race-${randomUUID()}@inv-prov.example`;
    const subA = `sub-race-a-${randomUUID()}`;
    const subB = `sub-race-b-${randomUUID()}`;
    const { secretHash } = await seedInvite({ email, role: 'member' });

    const provisioner = new PgInviteProvisioner({ pool: env.appPool });
    const now = new Date();

    // Fire both concurrently — exactly one transaction wins the consume UPDATE.
    const [resultA, resultB] = await Promise.all([
      provisioner.provisionFromInvite(tenantId, {
        email,
        inviteTokenHash: secretHash,
        providerSub: subA,
        now,
      }),
      provisioner.provisionFromInvite(tenantId, {
        email,
        inviteTokenHash: secretHash,
        providerSub: subB,
        now,
      }),
    ]);

    // Exactly one succeeds, one gets null.
    const results = [resultA, resultB];
    const successes = results.filter((r) => r !== null);
    const nulls = results.filter((r) => r === null);
    expect(successes).toHaveLength(1);
    expect(nulls).toHaveLength(1);

    const winnerId = (successes[0] as { userId: string }).userId;

    // Exactly one user exists for this email.
    const users = await env.adminPool.query<{ id: string }>(
      `SELECT id FROM users WHERE tenant_id = $1 AND email = $2`,
      [tenantId, email],
    );
    expect(users.rows).toHaveLength(1);
    expect((users.rows[0] as { id: string }).id).toBe(winnerId);

    // Exactly one membership for the winner.
    const memberships = await env.adminPool.query<{ user_id: string }>(
      `SELECT user_id FROM memberships WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, winnerId],
    );
    expect(memberships.rows).toHaveLength(1);
  });
});
