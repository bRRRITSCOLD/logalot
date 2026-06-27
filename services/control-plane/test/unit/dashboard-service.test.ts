import { beforeEach, describe, expect, it } from 'vitest';
import type { DashboardPatch, DashboardRepository, NewDashboard } from '../../src/app/ports';
import { DashboardService } from '../../src/app/dashboard-service';
import type { Dashboard } from '../../src/domain/entities';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../src/domain/errors';
import type { TenantContext } from '../../src/domain/tenant-context';

const TENANT = '00000000-0000-0000-0000-00000000000a';
const PRINCIPAL = '00000000-0000-0000-0000-0000000000c1';

function ctx(role: TenantContext['role']): TenantContext {
  return { tenantId: TENANT, principalId: PRINCIPAL, role };
}

function dashFrom(tenantId: string, input: NewDashboard, id = 'd-1'): Dashboard {
  return {
    id,
    tenantId,
    name: input.name,
    description: input.description ?? null,
    layout: input.layout,
    createdBy: input.createdBy,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

class FakeRepo implements DashboardRepository {
  private rows = new Map<string, Dashboard>();
  private seq = 0;

  async create(tenantId: string, input: NewDashboard): Promise<Dashboard> {
    for (const r of this.rows.values()) {
      if (r.tenantId === tenantId && r.name === input.name) {
        throw Object.assign(new Error('duplicate'), { code: '23505' });
      }
    }
    const dash = dashFrom(tenantId, input, `d-${++this.seq}`);
    this.rows.set(dash.id, dash);
    return dash;
  }
  async list(tenantId: string): Promise<Dashboard[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId);
  }
  async findById(tenantId: string, id: string): Promise<Dashboard | null> {
    const r = this.rows.get(id);
    return r && r.tenantId === tenantId ? r : null;
  }
  async update(tenantId: string, id: string, patch: DashboardPatch): Promise<Dashboard | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    const next = { ...r, ...patch } as Dashboard;
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

const SAVED_QUERY_ID = '00000000-0000-0000-0000-000000000001';

const baseCreate = {
  name: 'ops dashboard',
  layout: {
    panels: [
      {
        id: 'p1',
        type: 'timeseries' as const,
        title: '5xx rate',
        savedQueryId: SAVED_QUERY_ID,
        viz: {},
        grid: { x: 0, y: 0, w: 6, h: 4 },
      },
    ],
  },
};

describe('DashboardService', () => {
  let repo: FakeRepo;
  let svc: DashboardService;
  beforeEach(() => {
    repo = new FakeRepo();
    svc = new DashboardService(repo);
  });

  it('DashboardService_AdminCreates_StampsTenantAndCreatedByFromContext', async () => {
    const dash = await svc.create(ctx('tenant_admin'), baseCreate);
    expect(dash.tenantId).toBe(TENANT); // from context, never the body
    expect(dash.createdBy).toBe(PRINCIPAL);
    expect(dash.layout.panels).toHaveLength(1);
  });

  it('DashboardService_MemberCreate_ForbiddenByRbac', async () => {
    await expect(svc.create(ctx('member'), baseCreate)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('DashboardService_DuplicateName_Conflict', async () => {
    await svc.create(ctx('tenant_admin'), baseCreate);
    await expect(svc.create(ctx('tenant_admin'), baseCreate)).rejects.toBeInstanceOf(ConflictError);
  });

  it('DashboardService_MemberReadsAndLists_Allowed', async () => {
    await svc.create(ctx('tenant_admin'), baseCreate);
    const list = await svc.list(ctx('member'));
    expect(list).toHaveLength(1);
    const got = await svc.get(ctx('member'), list[0]?.id ?? '');
    expect(got.name).toBe(baseCreate.name);
  });

  it('DashboardService_GetMissing_NotFound', async () => {
    await expect(svc.get(ctx('member'), 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('DashboardService_Update_PatchesLayoutAndName', async () => {
    const created = await svc.create(ctx('tenant_admin'), baseCreate);
    const updated = await svc.update(ctx('tenant_admin'), created.id, {
      name: 'renamed',
      layout: { panels: [] },
    });
    expect(updated.name).toBe('renamed');
    expect(updated.layout.panels).toHaveLength(0);
  });

  it('DashboardService_MemberUpdate_ForbiddenByRbac', async () => {
    const created = await svc.create(ctx('tenant_admin'), baseCreate);
    await expect(
      svc.update(ctx('member'), created.id, { name: 'hack' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('DashboardService_DeleteThenGet_NotFound', async () => {
    const created = await svc.create(ctx('tenant_admin'), baseCreate);
    await svc.remove(ctx('tenant_admin'), created.id);
    await expect(svc.get(ctx('tenant_admin'), created.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('DashboardService_MemberDelete_ForbiddenByRbac', async () => {
    const created = await svc.create(ctx('tenant_admin'), baseCreate);
    await expect(svc.remove(ctx('member'), created.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
