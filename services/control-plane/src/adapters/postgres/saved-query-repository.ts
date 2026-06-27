import type { Pool } from 'pg';
import type { NewSavedQuery, SavedQueryPatch, SavedQueryRepository } from '../../app/ports';
import type { SavedQuery, SavedQueryFilters } from '../../domain/entities';
import { isUniqueViolation, withTenantTx } from './tenant-tx';

interface SavedQueryRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  query_text: string;
  filters: SavedQueryFilters;
  time_range: Record<string, unknown>;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function toSavedQuery(row: SavedQueryRow): SavedQuery {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    queryText: row.query_text,
    filters: row.filters ?? {},
    timeRange: row.time_range ?? {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = `id, tenant_id, name, description, query_text, filters, time_range,
  created_by, created_at, updated_at`;

// PgSavedQueryRepository persists saved_queries under tenant RLS (as the
// NOSUPERUSER logalot_app role). tenant_id is stamped from the armed context,
// so the WITH CHECK policy admits the row only for the acting tenant.
// Grants: migration 000011 blanket DML grant covers saved_queries.
export class PgSavedQueryRepository implements SavedQueryRepository {
  constructor(private readonly pool: Pool) {}

  async create(tenantId: string, input: NewSavedQuery): Promise<SavedQuery> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<SavedQueryRow>(
        `INSERT INTO saved_queries
           (tenant_id, name, description, query_text, filters, time_range, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
         RETURNING ${COLUMNS}`,
        [
          tenantId,
          input.name,
          input.description ?? null,
          input.queryText,
          JSON.stringify(input.filters ?? {}),
          JSON.stringify(input.timeRange ?? {}),
          input.createdBy,
        ],
      );
      return toSavedQuery(res.rows[0] as SavedQueryRow);
    });
  }

  async list(tenantId: string): Promise<SavedQuery[]> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<SavedQueryRow>(
        `SELECT ${COLUMNS} FROM saved_queries ORDER BY created_at DESC`,
      );
      return res.rows.map(toSavedQuery);
    });
  }

  async findById(tenantId: string, id: string): Promise<SavedQuery | null> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<SavedQueryRow>(
        `SELECT ${COLUMNS} FROM saved_queries WHERE id = $1`,
        [id],
      );
      const row = res.rows[0];
      return row ? toSavedQuery(row) : null;
    });
  }

  async update(tenantId: string, id: string, patch: SavedQueryPatch): Promise<SavedQuery | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, value: unknown, cast = ''): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}${cast}`);
    };

    if (patch.name !== undefined) add('name', patch.name);
    if (patch.description !== undefined) add('description', patch.description);
    if (patch.queryText !== undefined) add('query_text', patch.queryText);
    if (patch.filters !== undefined) add('filters', JSON.stringify(patch.filters), '::jsonb');
    if (patch.timeRange !== undefined)
      add('time_range', JSON.stringify(patch.timeRange), '::jsonb');

    if (sets.length === 0) {
      return this.findById(tenantId, id);
    }

    return withTenantTx(this.pool, tenantId, async (client) => {
      params.push(id);
      const res = await client.query<SavedQueryRow>(
        `UPDATE saved_queries SET ${sets.join(', ')} WHERE id = $${params.length}
         RETURNING ${COLUMNS}`,
        params,
      );
      const row = res.rows[0];
      return row ? toSavedQuery(row) : null;
    });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query(`DELETE FROM saved_queries WHERE id = $1`, [id]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}

export { isUniqueViolation };
