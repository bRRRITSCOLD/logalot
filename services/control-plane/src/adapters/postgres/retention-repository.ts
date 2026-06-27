import type { Pool } from 'pg';
import type { RetentionInput, RetentionRepository } from '../../app/ports';
import type { RetentionPolicy } from '../../domain/entities';
import { withTenantTx } from './tenant-tx';

interface RetentionRow {
  tenant_id: string;
  hot_days: number;
  cold_days: number;
  created_at: Date;
  updated_at: Date;
}

function toPolicy(row: RetentionRow): RetentionPolicy {
  return {
    tenantId: row.tenant_id,
    hotDays: row.hot_days,
    coldDays: row.cold_days,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = 'tenant_id, hot_days, cold_days, created_at, updated_at';

// PgRetentionRepository persists the per-tenant retention policy (1:1) under
// tenant RLS. upsert stamps tenant_id from the armed context, so the WITH CHECK
// policy admits the row only for the acting tenant.
export class PgRetentionRepository implements RetentionRepository {
  constructor(private readonly pool: Pool) {}

  async get(tenantId: string): Promise<RetentionPolicy | null> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<RetentionRow>(`SELECT ${COLUMNS} FROM retention_policies`);
      const row = res.rows[0];
      return row ? toPolicy(row) : null;
    });
  }

  async upsert(tenantId: string, input: RetentionInput): Promise<RetentionPolicy> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<RetentionRow>(
        `INSERT INTO retention_policies (tenant_id, hot_days, cold_days, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id) DO UPDATE
            SET hot_days = EXCLUDED.hot_days,
                cold_days = EXCLUDED.cold_days,
                updated_by = EXCLUDED.updated_by
         RETURNING ${COLUMNS}`,
        [tenantId, input.hotDays, input.coldDays, input.updatedBy],
      );
      return toPolicy(res.rows[0] as RetentionRow);
    });
  }
}
