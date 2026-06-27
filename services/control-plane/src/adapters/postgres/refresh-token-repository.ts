import type { Pool } from 'pg';
import type { NewRefreshToken, RefreshTokenRepository, RefreshTokenRow } from '../../app/ports';
import { withTenantTx } from './tenant-tx';

interface DbRow {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: Buffer;
  expires_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
}

function toRow(row: DbRow): RefreshTokenRow {
  return {
    id: row.id,
    userId: row.user_id,
    familyId: row.family_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
  };
}

const COLUMNS = 'id, user_id, family_id, token_hash, expires_at, rotated_at, revoked_at';

// PgRefreshTokenRepository persists refresh tokens under tenant RLS (migration
// 000012). It stores ONLY sha256(secret) (token_hash bytea, 32 bytes) — never the
// plaintext. The rotation/reuse-detection policy lives in AuthService; this is
// pure storage.
export class PgRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly pool: Pool) {}

  async create(tenantId: string, input: NewRefreshToken): Promise<{ id: string }> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO refresh_tokens (tenant_id, user_id, family_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [tenantId, input.userId, input.familyId, input.tokenHash, input.expiresAt],
      );
      return { id: (res.rows[0] as { id: string }).id };
    });
  }

  async findById(tenantId: string, id: string): Promise<RefreshTokenRow | null> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<DbRow>(`SELECT ${COLUMNS} FROM refresh_tokens WHERE id = $1`, [
        id,
      ]);
      const row = res.rows[0];
      return row ? toRow(row) : null;
    });
  }

  async rotate(
    tenantId: string,
    presentedId: string,
    now: Date,
    successor: NewRefreshToken,
  ): Promise<{ id: string } | null> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      // Conditional consume: only the FIRST presentation of a live token matches,
      // so two concurrent refreshes can never both rotate it (TOCTOU guard). The
      // 0-rows case means another tx already consumed (or revoked) it -> reuse.
      const consumed = await client.query(
        `UPDATE refresh_tokens SET rotated_at = $2
           WHERE id = $1 AND rotated_at IS NULL AND revoked_at IS NULL
         RETURNING family_id`,
        [presentedId, now],
      );
      if (consumed.rowCount === 0) {
        return null;
      }
      // Mint the successor in the SAME tx, so consume+mint are all-or-nothing.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO refresh_tokens (tenant_id, user_id, family_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [tenantId, successor.userId, successor.familyId, successor.tokenHash, successor.expiresAt],
      );
      return { id: (inserted.rows[0] as { id: string }).id };
    });
  }

  async revokeFamily(tenantId: string, familyId: string, now: Date): Promise<void> {
    await withTenantTx(this.pool, tenantId, async (client) => {
      await client.query(
        'UPDATE refresh_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL',
        [familyId, now],
      );
    });
  }
}
