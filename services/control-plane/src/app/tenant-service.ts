import { NotFoundError } from '../domain/errors';
import type { Tenant, TenantStatus, User } from '../domain/entities';
import type { TenantContext } from '../domain/tenant-context';
import { assertCan } from './authorize';
import type { PasswordHasher, TenantRepository, UserRepository } from './ports';

export interface CreateTenantCommand {
  publicId: string;
  name: string;
}

export interface ProvisionAdminCommand {
  email: string;
  password: string;
  displayName?: string;
}

// TenantService manages the tenant REGISTRY (no RLS — model.md §4.5); every
// operation is gated by the platform_operator role via the RBAC matrix. A
// tenant_admin/member may read only its own tenant row.
export class TenantService {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
  ) {}

  async create(ctx: TenantContext, cmd: CreateTenantCommand): Promise<Tenant> {
    assertCan(ctx, 'tenant:create');
    return this.tenants.create({ publicId: cmd.publicId, name: cmd.name });
  }

  // provisionAdmin creates a tenant's first tenant_admin. Only platform_operator
  // may do this — it is how a brand-new tenant gets an admin, since user:create is
  // tenant_admin-only and the operator is otherwise barred from tenant content.
  // Provisioning a credential is administrative, not reading tenant content
  // (NFR-5.4). It runs under the TARGET tenant's RLS scope (UserRepository.create
  // arms `SET LOCAL app.tenant_id` for that tenant).
  async provisionAdmin(
    ctx: TenantContext,
    tenantId: string,
    cmd: ProvisionAdminCommand,
  ): Promise<User> {
    assertCan(ctx, 'tenant:provision_admin');
    const tenant = await this.tenants.findById(tenantId);
    if (!tenant) {
      throw new NotFoundError('tenant not found');
    }
    const passwordHash = await this.hasher.hash(cmd.password);
    return this.users.create(tenantId, {
      email: cmd.email,
      passwordHash,
      displayName: cmd.displayName ?? null,
      role: 'tenant_admin',
    });
  }

  async list(ctx: TenantContext): Promise<Tenant[]> {
    assertCan(ctx, 'tenant:list');
    return this.tenants.list();
  }

  async get(ctx: TenantContext, id: string): Promise<Tenant> {
    assertCan(ctx, 'tenant:read');
    // A non-operator may read ONLY its own tenant row (the registry has no RLS, so
    // this scoping is enforced here).
    if (ctx.role !== 'platform_operator' && id !== ctx.tenantId) {
      throw new NotFoundError('tenant not found');
    }
    const tenant = await this.tenants.findById(id);
    if (!tenant) {
      throw new NotFoundError('tenant not found');
    }
    return tenant;
  }

  async update(
    ctx: TenantContext,
    id: string,
    patch: { name?: string; status?: TenantStatus },
  ): Promise<Tenant> {
    assertCan(ctx, 'tenant:update');
    const tenant = await this.tenants.update(id, patch);
    if (!tenant) {
      throw new NotFoundError('tenant not found');
    }
    return tenant;
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    assertCan(ctx, 'tenant:delete');
    const deleted = await this.tenants.delete(id);
    if (!deleted) {
      throw new NotFoundError('tenant not found');
    }
  }
}
