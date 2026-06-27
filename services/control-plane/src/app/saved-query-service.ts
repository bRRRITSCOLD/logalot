import { isUniqueViolation } from '../adapters/postgres/tenant-tx';
import type { SavedQuery, SavedQueryFilters } from '../domain/entities';
import { ConflictError, NotFoundError } from '../domain/errors';
import type { TenantContext } from '../domain/tenant-context';
import { assertCan } from './authorize';
import type { SavedQueryPatch, SavedQueryRepository } from './ports';

export interface CreateSavedQueryCommand {
  name: string;
  description?: string | null;
  queryText: string;
  filters: SavedQueryFilters;
  timeRange: Record<string, unknown>;
}

// SavedQueryService is the CRUD application core for saved queries (tenant_admin
// for writes; member may read). Every call is run under the tenant's RLS scope via
// the repository (via withTenantTx). The saved_query's definition fields
// (queryText, filters, timeRange) are controlled entirely by the tenant; the
// control-plane never interprets them — panels and alert rules consume them by id.
export class SavedQueryService {
  constructor(private readonly queries: SavedQueryRepository) {}

  async create(ctx: TenantContext, cmd: CreateSavedQueryCommand): Promise<SavedQuery> {
    assertCan(ctx, 'savedquery:create');
    try {
      return await this.queries.create(ctx.tenantId, {
        name: cmd.name,
        description: cmd.description ?? null,
        queryText: cmd.queryText,
        filters: cmd.filters,
        timeRange: cmd.timeRange,
        createdBy: ctx.principalId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(`a saved query named '${cmd.name}' already exists`);
      }
      throw err;
    }
  }

  async list(ctx: TenantContext): Promise<SavedQuery[]> {
    assertCan(ctx, 'savedquery:list');
    return this.queries.list(ctx.tenantId);
  }

  async get(ctx: TenantContext, id: string): Promise<SavedQuery> {
    assertCan(ctx, 'savedquery:read');
    const sq = await this.queries.findById(ctx.tenantId, id);
    if (!sq) {
      // Also returned when RLS makes a foreign-tenant saved query invisible —
      // probing is indistinguishable from a genuine miss.
      throw new NotFoundError('saved query not found');
    }
    return sq;
  }

  async update(ctx: TenantContext, id: string, patch: SavedQueryPatch): Promise<SavedQuery> {
    assertCan(ctx, 'savedquery:update');
    let updated: SavedQuery | null;
    try {
      updated = await this.queries.update(ctx.tenantId, id, patch);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('a saved query with that name already exists');
      }
      throw err;
    }
    if (!updated) {
      throw new NotFoundError('saved query not found');
    }
    return updated;
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    assertCan(ctx, 'savedquery:delete');
    const deleted = await this.queries.delete(ctx.tenantId, id);
    if (!deleted) {
      throw new NotFoundError('saved query not found');
    }
  }
}
