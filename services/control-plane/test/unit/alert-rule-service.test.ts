import { beforeEach, describe, expect, it } from 'vitest';
import { AlertRuleService } from '../../src/app/alert-rule-service';
import type { AlertRulePatch, AlertRuleRepository, NewAlertRule } from '../../src/app/ports';
import type { AlertRule } from '../../src/domain/entities';
import { ConflictError, ForbiddenError, NotFoundError } from '../../src/domain/errors';
import type { TenantContext } from '../../src/domain/tenant-context';

const TENANT = '00000000-0000-0000-0000-00000000000a';
const PRINCIPAL = '00000000-0000-0000-0000-0000000000c1';

function ctx(role: TenantContext['role']): TenantContext {
  return { tenantId: TENANT, principalId: PRINCIPAL, role };
}

function ruleFrom(tenantId: string, input: NewAlertRule, id = 'r-1'): AlertRule {
  return {
    id,
    tenantId,
    name: input.name,
    savedQueryId: input.savedQueryId,
    query: input.query,
    comparator: input.comparator,
    threshold: input.threshold,
    windowSeconds: input.windowSeconds,
    severity: input.severity,
    enabled: input.enabled,
    notifyChannels: input.notifyChannels,
    state: 'ok',
    lastEvaluatedAt: null,
    lastTriggeredAt: null,
    createdBy: input.createdBy,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

// In-memory repo modeling tenant scoping + the UNIQUE (tenant_id, name) constraint.
class FakeRepo implements AlertRuleRepository {
  private rows = new Map<string, AlertRule>();
  private seq = 0;

  async create(tenantId: string, input: NewAlertRule): Promise<AlertRule> {
    for (const r of this.rows.values()) {
      if (r.tenantId === tenantId && r.name === input.name) {
        throw Object.assign(new Error('duplicate'), { code: '23505' });
      }
    }
    const rule = ruleFrom(tenantId, input, `r-${++this.seq}`);
    this.rows.set(rule.id, rule);
    return rule;
  }
  async list(tenantId: string): Promise<AlertRule[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId);
  }
  async findById(tenantId: string, id: string): Promise<AlertRule | null> {
    const r = this.rows.get(id);
    return r && r.tenantId === tenantId ? r : null;
  }
  async update(tenantId: string, id: string, patch: AlertRulePatch): Promise<AlertRule | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    const next = { ...r, ...patch } as AlertRule;
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
  name: 'too many errors',
  savedQueryId: null,
  query: { level: 'error' as const },
  comparator: 'gt' as const,
  threshold: 5,
  windowSeconds: 300,
  severity: 'critical',
  enabled: true,
  notifyChannels: [{ type: 'webhook' as const, url: 'https://hooks.example/x' }],
};

describe('AlertRuleService', () => {
  let repo: FakeRepo;
  let svc: AlertRuleService;
  beforeEach(() => {
    repo = new FakeRepo();
    svc = new AlertRuleService(repo);
  });

  it('AlertRuleService_AdminCreates_StampsTenantAndCreatedByFromContext', async () => {
    const rule = await svc.create(ctx('tenant_admin'), baseCreate);
    expect(rule.tenantId).toBe(TENANT); // from context, never the body
    expect(rule.createdBy).toBe(PRINCIPAL);
    expect(rule.state).toBe('ok'); // never firing on create
  });

  it('AlertRuleService_MemberCreate_ForbiddenByRbac', async () => {
    await expect(svc.create(ctx('member'), baseCreate)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('AlertRuleService_DuplicateName_Conflict', async () => {
    await svc.create(ctx('tenant_admin'), baseCreate);
    await expect(svc.create(ctx('tenant_admin'), baseCreate)).rejects.toBeInstanceOf(ConflictError);
  });

  it('AlertRuleService_MemberReadsAndLists_Allowed', async () => {
    await svc.create(ctx('tenant_admin'), baseCreate);
    const list = await svc.list(ctx('member'));
    expect(list).toHaveLength(1);
    const got = await svc.get(ctx('member'), list[0]?.id ?? '');
    expect(got.name).toBe(baseCreate.name);
  });

  it('AlertRuleService_GetMissing_NotFound', async () => {
    await expect(svc.get(ctx('member'), 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('AlertRuleService_Update_PatchesAndStaysTenantScoped', async () => {
    const created = await svc.create(ctx('tenant_admin'), baseCreate);
    const updated = await svc.update(ctx('tenant_admin'), created.id, {
      enabled: false,
      threshold: 10,
    });
    expect(updated.enabled).toBe(false);
    expect(updated.threshold).toBe(10);
  });

  it('AlertRuleService_MemberUpdate_ForbiddenByRbac', async () => {
    const created = await svc.create(ctx('tenant_admin'), baseCreate);
    await expect(svc.update(ctx('member'), created.id, { enabled: false })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('AlertRuleService_DeleteThenGet_NotFound', async () => {
    const created = await svc.create(ctx('tenant_admin'), baseCreate);
    await svc.remove(ctx('tenant_admin'), created.id);
    await expect(svc.get(ctx('tenant_admin'), created.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
