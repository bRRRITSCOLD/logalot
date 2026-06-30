import type { Pool, PoolClient } from 'pg';
import type { InviteRepository, NewInvite } from '../../app/ports';
import type { ConsumedInvite, Invite, InviteRef } from '../../domain/entities';
import { withTenantTx } from './tenant-tx';

// InviteRow is the raw postgres row shape for the invites table (migration 000018).
// token_hash is a write-only field — it is never read back in any projection;
// COLUMNS omits it intentionally (ADR-0012, R-INV-2).
interface InviteRow {
  id: string;
  tenant_id: string;
  email: string;
  role: string;
  status: string;
  invited_by: string | null;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ConsumeResultRow is the shape of the RETURNING clause in the atomic consume UPDATE.
// Only id, role, email are returned — the minimal set the provisioner (T9) needs for
// JIT user creation + role translation (ADR-0012 §4).
interface ConsumeResultRow {
  id: string;
  role: string;
  email: string;
  consumed_at: Date;
}

// FindValidRow is the minimal shape returned by the liveness probe SELECT.
interface FindValidRow {
  id: string;
  tenant_id: string;
  email: string;
}

// COLUMNS is the public projection — never includes token_hash (ADR-0012, R-INV-2).
const COLUMNS =
  'id, tenant_id, email, role, status, created_by AS invited_by, expires_at, consumed_at, created_at, updated_at';

function toInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    role: row.role,
    status: row.status as Invite['status'],
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// consumeWithClient is exported so the provisioner (T9) can call it from inside a
// shared transaction (the single-transaction unit-of-work: ADR-0012 §5). It runs
// the sole atomic conditional UPDATE that is the at-most-once consume authority.
//
// tenant_id is NOT in the WHERE — RLS armed on the client's transaction scopes the
// statement to `app.current_tenant_id()` (the house pattern; data-model §4).
//
// Returns null on zero rows — every failure mode (no such token, wrong email,
// expired, revoked, already consumed, lost the race) collapses to null →
// uniform 401 in the auth layer (R-INV-6, no enumeration oracle).
export async function consumeWithClient(
  client: PoolClient,
  input: { tokenHash: Buffer; email: string; now: Date },
): Promise<ConsumedInvite | null> {
  const res = await client.query<ConsumeResultRow>(
    `UPDATE invites
        SET status      = 'consumed',
            consumed_at = $3
      WHERE token_hash  = $1
        AND email       = $2
        AND status      = 'pending'
        AND expires_at  > $3
     RETURNING id, role, email, consumed_at`,
    [input.tokenHash, input.email, input.now],
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0] as ConsumeResultRow;
  return {
    inviteId: row.id,
    role: row.role,
    email: row.email,
    consumedAt: row.consumed_at,
  };
}

// PgInviteRepository persists invites under tenant RLS (migration 000018).
// The public projection (Invite / InviteRef / ConsumedInvite) NEVER carries
// token_hash, the secret, or any derivation of it outward (ADR-0012, R-INV-2).
// All writes run inside withTenantTx — the pooled connection is tenant-scoped
// for the duration of the statement, then released back to the pool.
export class PgInviteRepository implements InviteRepository {
  constructor(private readonly pool: Pool) {}

  async create(tenantId: string, input: NewInvite): Promise<Invite> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<InviteRow>(
        `INSERT INTO invites (tenant_id, email, role, token_hash, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${COLUMNS}`,
        [tenantId, input.email, input.role, input.secretHash, input.invitedBy, input.expiresAt],
      );
      return toInvite(res.rows[0] as InviteRow);
    });
  }

  // findValidByTokenHash is a read-only liveness probe: it returns the InviteRef
  // for a pending, unexpired invite by token_hash — for UX fail-fast BEFORE
  // bouncing the invitee to Google. It NEVER mutates status and is NOT the
  // security authority; the consume below is (ADR-0012).
  async findValidByTokenHash(
    tenantId: string,
    tokenHash: Buffer,
    now: Date,
  ): Promise<InviteRef | null> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<FindValidRow>(
        `SELECT id, tenant_id, email
           FROM invites
          WHERE token_hash = $1
            AND status     = 'pending'
            AND expires_at > $2`,
        [tokenHash, now],
      );
      if (res.rowCount === 0) return null;
      const row = res.rows[0] as FindValidRow;
      return { id: row.id, tenantId: row.tenant_id, email: row.email };
    });
  }

  // consume is the public single-arg form: wraps withTenantTx and delegates to
  // consumeWithClient for the conditional UPDATE. The provisioner (T9) uses
  // consumeWithClient directly to share the transaction with user creation.
  async consume(
    tenantId: string,
    input: { tokenHash: Buffer; email: string; now: Date },
  ): Promise<ConsumedInvite | null> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      return consumeWithClient(client, input);
    });
  }

  async listByTenant(tenantId: string): Promise<Invite[]> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<InviteRow>(
        `SELECT ${COLUMNS} FROM invites ORDER BY created_at DESC`,
      );
      return res.rows.map(toInvite);
    });
  }

  // revoke flips status to 'revoked' only when the invite is currently 'pending'.
  // Returns true when the row was found and flipped, false when absent or already
  // consumed/revoked (idempotent to callers — mirrors PgApiKeyRepository.revoke).
  // _now is accepted for interface compatibility; updated_at advances via the
  // trg_invites_updated trigger (no revoked_at column on invites).
  async revoke(tenantId: string, id: string, _now: Date): Promise<boolean> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query(
        `UPDATE invites
            SET status = 'revoked'
          WHERE id     = $1
            AND status = 'pending'`,
        [id],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }
}
