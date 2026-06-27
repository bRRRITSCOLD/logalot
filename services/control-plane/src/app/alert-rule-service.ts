import type { AlertComparator, AlertRule, NotifyChannel, RuleQuery } from '../domain/entities';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import type { TenantContext } from '../domain/tenant-context';
import { assertCan } from './authorize';
import type { AlertRulePatch, AlertRuleRepository } from './ports';

export interface CreateAlertRuleCommand {
  name: string;
  savedQueryId?: string | null;
  query: RuleQuery;
  comparator: AlertComparator;
  threshold: number;
  windowSeconds: number;
  severity: string;
  enabled: boolean;
  notifyChannels: NotifyChannel[];
}

// AlertRuleService is the CRUD application core for alert rules (tenant_admin for
// writes; member may read). Every call runs under the tenant's RLS scope via the
// repository. The evaluator-owned fields (state, last_evaluated_at, transition_seq)
// are never settable here — the control-plane configures rules; the alert-evaluator
// worker evaluates them (ADR-0001).
export class AlertRuleService {
  constructor(private readonly rules: AlertRuleRepository) {}

  async create(ctx: TenantContext, cmd: CreateAlertRuleCommand): Promise<AlertRule> {
    assertCan(ctx, 'alert:create');
    this.assertChannels(cmd.notifyChannels);
    try {
      return await this.rules.create(ctx.tenantId, {
        name: cmd.name,
        savedQueryId: cmd.savedQueryId ?? null,
        query: cmd.query,
        comparator: cmd.comparator,
        threshold: cmd.threshold,
        windowSeconds: cmd.windowSeconds,
        severity: cmd.severity,
        enabled: cmd.enabled,
        notifyChannels: cmd.notifyChannels,
        createdBy: ctx.principalId,
      });
    } catch (err) {
      // UNIQUE (tenant_id, name) — surface a 409 rather than a 500.
      if (isUniqueName(err)) {
        throw new ConflictError(`an alert rule named '${cmd.name}' already exists`);
      }
      throw err;
    }
  }

  async list(ctx: TenantContext): Promise<AlertRule[]> {
    assertCan(ctx, 'alert:list');
    return this.rules.list(ctx.tenantId);
  }

  async get(ctx: TenantContext, id: string): Promise<AlertRule> {
    assertCan(ctx, 'alert:read');
    const rule = await this.rules.findById(ctx.tenantId, id);
    if (!rule) {
      // Also returned when RLS makes a foreign-tenant rule invisible (probing is
      // indistinguishable from a genuine miss).
      throw new NotFoundError('alert rule not found');
    }
    return rule;
  }

  async update(ctx: TenantContext, id: string, patch: AlertRulePatch): Promise<AlertRule> {
    assertCan(ctx, 'alert:update');
    if (patch.notifyChannels) {
      this.assertChannels(patch.notifyChannels);
    }
    let updated: AlertRule | null;
    try {
      updated = await this.rules.update(ctx.tenantId, id, patch);
    } catch (err) {
      if (isUniqueName(err)) {
        throw new ConflictError('an alert rule with that name already exists');
      }
      throw err;
    }
    if (!updated) {
      throw new NotFoundError('alert rule not found');
    }
    return updated;
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    assertCan(ctx, 'alert:delete');
    const deleted = await this.rules.delete(ctx.tenantId, id);
    if (!deleted) {
      throw new NotFoundError('alert rule not found');
    }
  }

  // The zod contract already validates channel shape; this is a defense-in-depth
  // domain invariant (no empty target) independent of the boundary schema.
  private assertChannels(channels: NotifyChannel[]): void {
    for (const ch of channels) {
      if (ch.type === 'webhook' && !ch.url) {
        throw new ValidationError('webhook channel requires a url');
      }
      if (ch.type === 'email' && !ch.to) {
        throw new ValidationError('email channel requires a recipient');
      }
    }
  }
}

function isUniqueName(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
