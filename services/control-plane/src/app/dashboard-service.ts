import { isUniqueViolation } from '../adapters/postgres/tenant-tx';
import type { Dashboard, DashboardLayout } from '../domain/entities';
import { ConflictError, NotFoundError } from '../domain/errors';
import type { TenantContext } from '../domain/tenant-context';
import { assertCan } from './authorize';
import type { DashboardPatch, DashboardRepository } from './ports';

export interface CreateDashboardCommand {
  name: string;
  description?: string | null;
  layout: DashboardLayout;
}

// DashboardService is the CRUD application core for dashboards (tenant_admin for
// writes; member may read). Panels are owned inline (JSONB aggregate boundary) and
// reference saved_queries by id. No FK validation of panel.savedQueryId is done
// here: an invisible (RLS-hidden or deleted) saved query yields no data at
// render time — a known-acceptable UX over a hard constraint (ADR-0001).
export class DashboardService {
  constructor(private readonly dashboards: DashboardRepository) {}

  async create(ctx: TenantContext, cmd: CreateDashboardCommand): Promise<Dashboard> {
    assertCan(ctx, 'dashboard:create');
    try {
      return await this.dashboards.create(ctx.tenantId, {
        name: cmd.name,
        description: cmd.description ?? null,
        layout: cmd.layout,
        createdBy: ctx.principalId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(`a dashboard named '${cmd.name}' already exists`);
      }
      throw err;
    }
  }

  async list(ctx: TenantContext): Promise<Dashboard[]> {
    assertCan(ctx, 'dashboard:list');
    return this.dashboards.list(ctx.tenantId);
  }

  async get(ctx: TenantContext, id: string): Promise<Dashboard> {
    assertCan(ctx, 'dashboard:read');
    const dash = await this.dashboards.findById(ctx.tenantId, id);
    if (!dash) {
      // Also returned when RLS makes a foreign-tenant dashboard invisible —
      // probing is indistinguishable from a genuine miss.
      throw new NotFoundError('dashboard not found');
    }
    return dash;
  }

  async update(ctx: TenantContext, id: string, patch: DashboardPatch): Promise<Dashboard> {
    assertCan(ctx, 'dashboard:update');
    let updated: Dashboard | null;
    try {
      updated = await this.dashboards.update(ctx.tenantId, id, patch);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('a dashboard with that name already exists');
      }
      throw err;
    }
    if (!updated) {
      throw new NotFoundError('dashboard not found');
    }
    return updated;
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    assertCan(ctx, 'dashboard:delete');
    const deleted = await this.dashboards.delete(ctx.tenantId, id);
    if (!deleted) {
      throw new NotFoundError('dashboard not found');
    }
  }
}
