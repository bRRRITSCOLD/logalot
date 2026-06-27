import type { Pool } from 'pg';
import type { NewTenant, TenantPatch, TenantRepository } from '../../app/ports';
import type { Tenant } from '../../domain/entities';
import { ConflictError } from '../../domain/errors';
import { isUniqueViolation } from './tenant-tx';

interface TenantRow {
  id: string;
  public_id: string;
  name: string;
  status: Tenant['status'];
  created_at: Date;
  updated_at: Date;
}

function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    publicId: row.public_id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = 'id, public_id, name, status, created_at, updated_at';

// PgTenantRepository persists the tenant REGISTRY. The table has no RLS
// (model.md §4.5), so these run as plain pool queries; the platform_operator
// authorization that protects them lives in TenantService.
export class PgTenantRepository implements TenantRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: NewTenant): Promise<Tenant> {
    try {
      const res = await this.pool.query<TenantRow>(
        `INSERT INTO tenants (public_id, name) VALUES ($1, $2) RETURNING ${COLUMNS}`,
        [input.publicId, input.name],
      );
      return toTenant(res.rows[0] as TenantRow);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(`tenant slug '${input.publicId}' already exists`);
      }
      throw err;
    }
  }

  async list(): Promise<Tenant[]> {
    const res = await this.pool.query<TenantRow>(
      `SELECT ${COLUMNS} FROM tenants ORDER BY created_at DESC`,
    );
    return res.rows.map(toTenant);
  }

  async findById(id: string): Promise<Tenant | null> {
    const res = await this.pool.query<TenantRow>(`SELECT ${COLUMNS} FROM tenants WHERE id = $1`, [
      id,
    ]);
    const row = res.rows[0];
    return row ? toTenant(row) : null;
  }

  async findByPublicId(publicId: string): Promise<Tenant | null> {
    const res = await this.pool.query<TenantRow>(
      `SELECT ${COLUMNS} FROM tenants WHERE public_id = $1`,
      [publicId],
    );
    const row = res.rows[0];
    return row ? toTenant(row) : null;
  }

  async update(id: string, patch: TenantPatch): Promise<Tenant | null> {
    const res = await this.pool.query<TenantRow>(
      `UPDATE tenants
         SET name   = COALESCE($2, name),
             status = COALESCE($3, status)
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [id, patch.name ?? null, patch.status ?? null],
    );
    const row = res.rows[0];
    return row ? toTenant(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
