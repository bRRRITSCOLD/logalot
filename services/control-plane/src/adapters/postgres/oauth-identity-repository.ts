import type { Pool } from 'pg';
import type { NewOAuthIdentity, OAuthIdentityRef, OAuthIdentityRepository } from '../../app/ports';
import type { OAuthIdentity, OAuthProvider } from '../../domain/entities';
import { ConflictError } from '../../domain/errors';
import { isUniqueViolation, withTenantTx } from './tenant-tx';

interface DbRow {
  id: string;
  tenant_id: string;
  user_id: string;
  provider: OAuthProvider;
  provider_sub: string;
  email: string;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toIdentity(row: DbRow): OAuthIdentity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    provider: row.provider,
    providerSub: row.provider_sub,
    email: row.email,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS =
  'id, tenant_id, user_id, provider, provider_sub, email, last_login_at, created_at, updated_at';

// PgOAuthIdentityRepository persists OAuth identity links under tenant RLS
// (migration 000017). Every statement arms RLS via withTenantTx so no identity
// is ever visible outside its tenant. The logalot_app pool (NOSUPERUSER) is the
// only connection used — no SECURITY DEFINER, no BYPASSRLS.
//
// linkFirst is idempotent: a 23505 on (tenant_id, provider, provider_sub) means a
// concurrent first-link already won; we re-SELECT within the SAME armed tenant
// context and return the winner's ref rather than raising a ConflictError. This
// makes concurrent first-link calls converge safely.
export class PgOAuthIdentityRepository implements OAuthIdentityRepository {
  constructor(private readonly pool: Pool) {}

  async findByProviderSub(
    tenantId: string,
    provider: OAuthProvider,
    providerSub: string,
  ): Promise<OAuthIdentityRef | null> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<{ id: string; user_id: string }>(
        `SELECT id, user_id
           FROM oauth_identities
          WHERE provider = $1 AND provider_sub = $2`,
        [provider, providerSub],
      );
      const row = res.rows[0];
      return row ? { id: row.id, userId: row.user_id } : null;
    });
  }

  async linkFirst(tenantId: string, input: NewOAuthIdentity): Promise<OAuthIdentityRef> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      // Use a SAVEPOINT so that a 23505 unique-violation only aborts the INSERT
      // sub-statement rather than the entire outer transaction. Without the
      // savepoint, Postgres puts the whole tx into the "aborted" state and the
      // re-SELECT below would fail with SQLSTATE 25P02.
      await client.query('SAVEPOINT link_first');
      try {
        const res = await client.query<{ id: string; user_id: string }>(
          `INSERT INTO oauth_identities (tenant_id, user_id, provider, provider_sub, email)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, user_id`,
          [tenantId, input.userId, input.provider, input.providerSub, input.email],
        );
        const row = res.rows[0] as { id: string; user_id: string };
        return { id: row.id, userId: row.user_id };
      } catch (err) {
        // A 23505 here can be EITHER of the table's two UNIQUE constraints, and
        // they mean opposite things — so we must distinguish, not assume:
        //
        //   (a) UNIQUE(tenant_id, provider, provider_sub) — a concurrent first-link
        //       for the SAME sub already won. Idempotent: roll back to the savepoint
        //       and re-resolve by (provider, provider_sub) to return the winner's ref.
        //       Under READ COMMITTED the winner row is visible by the time we receive
        //       the 23505.
        //
        //   (b) UNIQUE(tenant_id, user_id, provider) — this user is ALREADY linked to a
        //       DIFFERENT Google sub in this tenant (an attempt to re-pin the account to
        //       a new identity). The re-SELECT by the NEW (provider, provider_sub) then
        //       finds ZERO rows. This is a security-relevant rejection (threat model R13:
        //       sub-pinned), NOT an idempotent retry — surface it as a ConflictError so
        //       the app layer rejects with 401 instead of dereferencing rows[0] (which
        //       would throw and 500 — the bug this guards against).
        if (isUniqueViolation(err)) {
          await client.query('ROLLBACK TO SAVEPOINT link_first');
          const existing = await client.query<{ id: string; user_id: string }>(
            `SELECT id, user_id
               FROM oauth_identities
              WHERE provider = $1 AND provider_sub = $2`,
            [input.provider, input.providerSub],
          );
          const row = existing.rows[0];
          if (!row) {
            throw new ConflictError(
              'user is already linked to a different identity for this provider',
            );
          }
          return { id: row.id, userId: row.user_id };
        }
        throw err;
      }
    });
  }

  async touchLastLogin(tenantId: string, id: string, now: Date): Promise<void> {
    await withTenantTx(this.pool, tenantId, async (client) => {
      await client.query(`UPDATE oauth_identities SET last_login_at = $2 WHERE id = $1`, [id, now]);
    });
  }

  async findById(tenantId: string, id: string): Promise<OAuthIdentity | null> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<DbRow>(
        `SELECT ${COLUMNS} FROM oauth_identities WHERE id = $1`,
        [id],
      );
      const row = res.rows[0];
      return row ? toIdentity(row) : null;
    });
  }
}
