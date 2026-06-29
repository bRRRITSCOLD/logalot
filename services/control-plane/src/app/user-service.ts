import type { User } from '../domain/entities';
import { normalizeEmail } from '../domain/email';
import { NotFoundError } from '../domain/errors';
import type { MembershipRole } from '../domain/roles';
import type { TenantContext } from '../domain/tenant-context';
import { assertCan } from './authorize';
import type { PasswordHasher, UserRepository } from './ports';

export interface CreateUserCommand {
  email: string;
  password: string;
  displayName?: string;
  role: MembershipRole;
}

export interface UpdateUserCommand {
  displayName?: string | null;
  status?: string;
  role?: MembershipRole;
  // When present, the password is re-hashed before persistence (never stored or
  // logged in plaintext).
  password?: string;
}

// UserService manages users + memberships WITHIN the acting principal's tenant.
// The tenant is taken from the TenantContext (never the request body), and every
// repository call runs under that tenant's RLS scope, so cross-tenant access is
// impossible at two independent layers (RBAC here + RLS in the adapter).
export class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
  ) {}

  async create(ctx: TenantContext, cmd: CreateUserCommand): Promise<User> {
    assertCan(ctx, 'user:create');
    const passwordHash = await this.hasher.hash(cmd.password);
    return this.users.create(ctx.tenantId, {
      email: normalizeEmail(cmd.email),
      passwordHash,
      displayName: cmd.displayName ?? null,
      role: cmd.role,
    });
  }

  async list(ctx: TenantContext): Promise<User[]> {
    assertCan(ctx, 'user:list');
    return this.users.list(ctx.tenantId);
  }

  async get(ctx: TenantContext, id: string): Promise<User> {
    assertCan(ctx, 'user:read');
    const user = await this.users.findById(ctx.tenantId, id);
    if (!user) {
      throw new NotFoundError('user not found');
    }
    return user;
  }

  async update(ctx: TenantContext, id: string, cmd: UpdateUserCommand): Promise<User> {
    assertCan(ctx, 'user:update');
    const passwordHash = cmd.password ? await this.hasher.hash(cmd.password) : undefined;
    const user = await this.users.update(ctx.tenantId, id, {
      displayName: cmd.displayName,
      status: cmd.status,
      role: cmd.role,
      passwordHash,
    });
    if (!user) {
      throw new NotFoundError('user not found');
    }
    return user;
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    assertCan(ctx, 'user:delete');
    const deleted = await this.users.delete(ctx.tenantId, id);
    if (!deleted) {
      throw new NotFoundError('user not found');
    }
  }
}
