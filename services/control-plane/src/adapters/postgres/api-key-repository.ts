import type { Pool } from 'pg';
import type { ApiKeyRecord } from '../../domain/entities';
import type { ApiKeyRepository, NewApiKey } from '../../app/ports';
import { withTenantTx } from './tenant-tx';

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  name: string;
  scopes: string[];
  created_by: string | null;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

function toRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    scopes: row.scopes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

const COLUMNS =
  'id, tenant_id, name, scopes, created_by, created_at, expires_at, revoked_at, last_used_at';

// PgApiKeyRepository persists api_keys under tenant RLS. It stores ONLY the
// sha256(secret) hash (key_hash bytea, 32 bytes) per migration 000005 — never the
// plaintext. The hash is computed in the domain (api-key.ts) so it stays byte-
// identical to what the Go ingest Authenticator expects.
export class PgApiKeyRepository implements ApiKeyRepository {
  constructor(private readonly pool: Pool) {}

  async create(tenantId: string, input: NewApiKey): Promise<ApiKeyRecord> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<ApiKeyRow>(
        `INSERT INTO api_keys (id, tenant_id, name, key_hash, scopes, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COLUMNS}`,
        [
          input.keyId,
          tenantId,
          input.name,
          input.keyHash,
          input.scopes,
          input.createdBy,
          input.expiresAt,
        ],
      );
      return toRecord(res.rows[0] as ApiKeyRow);
    });
  }

  async list(tenantId: string): Promise<ApiKeyRecord[]> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<ApiKeyRow>(
        `SELECT ${COLUMNS} FROM api_keys ORDER BY created_at DESC`,
      );
      return res.rows.map(toRecord);
    });
  }

  async revoke(tenantId: string, keyId: string, now: Date): Promise<boolean> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query(
        `UPDATE api_keys SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`,
        [keyId, now],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }
}
