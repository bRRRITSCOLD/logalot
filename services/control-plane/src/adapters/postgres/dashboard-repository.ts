import type { Pool } from 'pg';
import type { DashboardPatch, DashboardRepository, NewDashboard } from '../../app/ports';
import type { Dashboard, DashboardLayout } from '../../domain/entities';
import { withTenantTx } from './tenant-tx';

interface DashboardRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  layout: DashboardLayout;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function toDashboard(row: DashboardRow): Dashboard {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    layout: row.layout ?? { panels: [] },
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = `id, tenant_id, name, description, layout,
  created_by, created_at, updated_at`;

// PgDashboardRepository persists dashboards under tenant RLS (as the NOSUPERUSER
// logalot_app role). The layout jsonb is the aggregate root for panels (inline
// ownership); panels are never persisted separately.
// Grants: migration 000011 blanket DML grant covers dashboards.
export class PgDashboardRepository implements DashboardRepository {
  constructor(private readonly pool: Pool) {}

  async create(tenantId: string, input: NewDashboard): Promise<Dashboard> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<DashboardRow>(
        `INSERT INTO dashboards
           (tenant_id, name, description, layout, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING ${COLUMNS}`,
        [
          tenantId,
          input.name,
          input.description ?? null,
          JSON.stringify(input.layout ?? { panels: [] }),
          input.createdBy,
        ],
      );
      return toDashboard(res.rows[0] as DashboardRow);
    });
  }

  async list(tenantId: string): Promise<Dashboard[]> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<DashboardRow>(
        `SELECT ${COLUMNS} FROM dashboards ORDER BY created_at DESC`,
      );
      return res.rows.map(toDashboard);
    });
  }

  async findById(tenantId: string, id: string): Promise<Dashboard | null> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<DashboardRow>(
        `SELECT ${COLUMNS} FROM dashboards WHERE id = $1`,
        [id],
      );
      const row = res.rows[0];
      return row ? toDashboard(row) : null;
    });
  }

  async update(tenantId: string, id: string, patch: DashboardPatch): Promise<Dashboard | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, value: unknown, cast = ''): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}${cast}`);
    };

    if (patch.name !== undefined) add('name', patch.name);
    if (patch.description !== undefined) add('description', patch.description);
    if (patch.layout !== undefined) add('layout', JSON.stringify(patch.layout), '::jsonb');

    if (sets.length === 0) {
      return this.findById(tenantId, id);
    }

    return withTenantTx(this.pool, tenantId, async (client) => {
      params.push(id);
      const res = await client.query<DashboardRow>(
        `UPDATE dashboards SET ${sets.join(', ')} WHERE id = $${params.length}
         RETURNING ${COLUMNS}`,
        params,
      );
      const row = res.rows[0];
      return row ? toDashboard(row) : null;
    });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query(`DELETE FROM dashboards WHERE id = $1`, [id]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
