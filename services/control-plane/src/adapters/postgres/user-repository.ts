import type { Pool } from 'pg';
import { ConflictError } from '../../domain/errors';
import type { User } from '../../domain/entities';
import { isRole, type MembershipRole, type Role } from '../../domain/roles';
import type { AuthRecord, NewUser, UserPatch, UserRepository } from '../../app/ports';
import { isUniqueViolation, withTenantTx } from './tenant-tx';

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string | null;
  status: string;
  is_platform_operator: boolean;
  role: MembershipRole | null;
  created_at: Date;
  updated_at: Date;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    isPlatformOperator: row.is_platform_operator,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// SELECT projection joining the membership role onto the user. Every statement
// runs inside withTenantTx, so RLS already constrains both tables to the armed
// tenant — the queries carry no explicit tenant predicate and still cannot see
// another tenant's rows.
const SELECT_USER = `
  SELECT u.id, u.tenant_id, u.email, u.display_name, u.status, u.is_platform_operator,
         m.role AS role, u.created_at, u.updated_at
    FROM users u
    LEFT JOIN memberships m ON m.tenant_id = u.tenant_id AND m.user_id = u.id`;

interface AuthRow {
  id: string;
  password_hash: string;
  status: string;
  role: string | null;
}

function toAuthRecord(row: AuthRow): AuthRecord {
  const role: Role | null = isRole(row.role) ? row.role : null;
  return { id: row.id, passwordHash: row.password_hash, status: row.status, role };
}

// Authentication projection: folds the platform-operator rule into a single
// effective role (platform_operator when is_platform_operator, else the
// membership role). This is the only query that exposes password_hash.
const SELECT_AUTH = `
  SELECT u.id, u.password_hash, u.status,
         CASE WHEN u.is_platform_operator THEN 'platform_operator'
              ELSE m.role::text END AS role
    FROM users u
    LEFT JOIN memberships m ON m.tenant_id = u.tenant_id AND m.user_id = u.id`;

// PgUserRepository persists users + memberships under tenant RLS. create() writes
// both the user and its membership in ONE transaction (same aggregate), so a user
// never exists without its role.
export class PgUserRepository implements UserRepository {
  constructor(private readonly pool: Pool) {}

  async create(tenantId: string, input: NewUser): Promise<User> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      try {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO users (tenant_id, email, password_hash, display_name)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [tenantId, input.email, input.passwordHash, input.displayName ?? null],
        );
        const userId = (inserted.rows[0] as { id: string }).id;
        await client.query(
          `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`,
          [tenantId, userId, input.role],
        );
        const res = await client.query<UserRow>(`${SELECT_USER} WHERE u.id = $1`, [userId]);
        return toUser(res.rows[0] as UserRow);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(`a user with email '${input.email}' already exists`);
        }
        throw err;
      }
    });
  }

  async list(tenantId: string): Promise<User[]> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<UserRow>(`${SELECT_USER} ORDER BY u.created_at DESC`);
      return res.rows.map(toUser);
    });
  }

  async findById(tenantId: string, id: string): Promise<User | null> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<UserRow>(`${SELECT_USER} WHERE u.id = $1`, [id]);
      const row = res.rows[0];
      return row ? toUser(row) : null;
    });
  }

  async update(tenantId: string, id: string, patch: UserPatch): Promise<User | null> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const updated = await client.query<{ id: string }>(
        `UPDATE users
            SET display_name  = COALESCE($2, display_name),
                status        = COALESCE($3, status),
                password_hash = COALESCE($4, password_hash)
          WHERE id = $1
          RETURNING id`,
        [id, patch.displayName ?? null, patch.status ?? null, patch.passwordHash ?? null],
      );
      const row = updated.rows[0];
      if (!row) {
        return null;
      }
      if (patch.role) {
        await client.query(`UPDATE memberships SET role = $2 WHERE user_id = $1`, [id, patch.role]);
      }
      const res = await client.query<UserRow>(`${SELECT_USER} WHERE u.id = $1`, [id]);
      return toUser(res.rows[0] as UserRow);
    });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query('DELETE FROM users WHERE id = $1', [id]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  async findCredentialsByEmail(tenantId: string, email: string): Promise<AuthRecord | null> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<AuthRow>(`${SELECT_AUTH} WHERE u.email = $1`, [email]);
      const row = res.rows[0];
      return row ? toAuthRecord(row) : null;
    });
  }

  async findCredentialsById(tenantId: string, id: string): Promise<AuthRecord | null> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<AuthRow>(`${SELECT_AUTH} WHERE u.id = $1`, [id]);
      const row = res.rows[0];
      return row ? toAuthRecord(row) : null;
    });
  }
}
