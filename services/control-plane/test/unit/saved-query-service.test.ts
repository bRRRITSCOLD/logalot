import { beforeEach, describe, expect, it } from 'vitest';
import type { NewSavedQuery, SavedQueryPatch, SavedQueryRepository } from '../../src/app/ports';
import { SavedQueryService } from '../../src/app/saved-query-service';
import type { SavedQuery } from '../../src/domain/entities';
import { ConflictError, ForbiddenError, NotFoundError } from '../../src/domain/errors';
import type { TenantContext } from '../../src/domain/tenant-context';

const TENANT = '00000000-0000-0000-0000-00000000000a';
const PRINCIPAL = '00000000-0000-0000-0000-0000000000c1';

function ctx(role: TenantContext['role']): TenantContext {
  return { tenantId: TENANT, principalId: PRINCIPAL, role };
}

function sqFrom(tenantId: string, input: NewSavedQuery, id = 'sq-1'): SavedQuery {
  return {
    id,
    tenantId,
    name: input.name,
    description: input.description ?? null,
    queryText: input.queryText,
    filters: input.filters,
    timeRange: input.timeRange,
    createdBy: input.createdBy,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

class FakeRepo implements SavedQueryRepository {
  private rows = new Map<string, SavedQuery>();
  private seq = 0;

  async create(tenantId: string, input: NewSavedQuery): Promise<SavedQuery> {
    for (const r of this.rows.values()) {
      if (r.tenantId === tenantId && r.name === input.name) {
        throw Object.assign(new Error('duplicate'), { code: '23505' });
      }
    }
    const sq = sqFrom(tenantId, input, `sq-${++this.seq}`);
    this.rows.set(sq.id, sq);
    return sq;
  }
  async list(tenantId: string): Promise<SavedQuery[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId);
  }
  async findById(tenantId: string, id: string): Promise<SavedQuery | null> {
    const r = this.rows.get(id);
    return r && r.tenantId === tenantId ? r : null;
  }
  async update(tenantId: string, id: string, patch: SavedQueryPatch): Promise<SavedQuery | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    const next = { ...r, ...patch } as SavedQuery;
    this.rows.set(id, next);
    return next;
  }
  async delete(tenantId: string, id: string): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return false;
    this.rows.delete(id);
    return true;
  }
}

const baseCreate = {
  name: 'error logs last 24h',
  queryText: 'error',
  filters: { level: 'error' as const, service: 'billing' },
  timeRange: { relative: '24h' },
};

describe('SavedQueryService', () => {
  let repo: FakeRepo;
  let svc: SavedQueryService;
  beforeEach(() => {
    repo = new FakeRepo();
    svc = new SavedQueryService(repo);
  });

  it('SavedQueryService_AdminCreates_StampsTenantAndCreatedByFromContext', async () => {
    const sq = await svc.create(ctx('tenant_admin'), baseCreate);
    expect(sq.tenantId).toBe(TENANT); // from context, never the body
    expect(sq.createdBy).toBe(PRINCIPAL);
    expect(sq.name).toBe(baseCreate.name);
  });

  it('SavedQueryService_MemberCreate_ForbiddenByRbac', async () => {
    await expect(svc.create(ctx('member'), baseCreate)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('SavedQueryService_DuplicateName_Conflict', async () => {
    await svc.create(ctx('tenant_admin'), baseCreate);
    await expect(svc.create(ctx('tenant_admin'), baseCreate)).rejects.toBeInstanceOf(ConflictError);
  });

  it('SavedQueryService_MemberReadsAndLists_Allowed', async () => {
    await svc.create(ctx('tenant_admin'), baseCreate);
    const list = await svc.list(ctx('member'));
    expect(list).toHaveLength(1);
    const got = await svc.get(ctx('member'), list[0]?.id ?? '');
    expect(got.name).toBe(baseCreate.name);
  });

  it('SavedQueryService_GetMissing_NotFound', async () => {
    await expect(svc.get(ctx('member'), 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('SavedQueryService_Update_PatchesFiltersAndName', async () => {
    const created = await svc.create(ctx('tenant_admin'), baseCreate);
    const updated = await svc.update(ctx('tenant_admin'), created.id, {
      name: 'renamed',
      filters: { level: 'warn' },
    });
    expect(updated.name).toBe('renamed');
    expect(updated.filters.level).toBe('warn');
  });

  it('SavedQueryService_MemberUpdate_ForbiddenByRbac', async () => {
    const created = await svc.create(ctx('tenant_admin'), baseCreate);
    await expect(svc.update(ctx('member'), created.id, { name: 'hack' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('SavedQueryService_DeleteThenGet_NotFound', async () => {
    const created = await svc.create(ctx('tenant_admin'), baseCreate);
    await svc.remove(ctx('tenant_admin'), created.id);
    await expect(svc.get(ctx('tenant_admin'), created.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('SavedQueryService_MemberDelete_ForbiddenByRbac', async () => {
    const created = await svc.create(ctx('tenant_admin'), baseCreate);
    await expect(svc.remove(ctx('member'), created.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
