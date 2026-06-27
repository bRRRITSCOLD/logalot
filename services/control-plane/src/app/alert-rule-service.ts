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
    // Defense-in-depth (independent of the boundary schema): a rule MUST have a
    // usable query source — exactly one of savedQueryId / non-empty inline query.
    // An empty inline query would make the evaluator count every log and fire (I2).
    this.assertQuerySource(cmd.savedQueryId ?? null, cmd.query);
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
    // If the inline query is being changed, it cannot be blanked to empty unless a
    // savedQueryId is supplied in the same patch (I2).
    if (patch.query !== undefined && !hasInlineQuery(patch.query) && patch.savedQueryId == null) {
      throw new ValidationError(
        'query cannot be emptied; set a savedQueryId to switch query source',
      );
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

  // A rule's query source must be EXACTLY ONE of: a saved query reference, or a
  // non-empty inline query. Both-empty would fire on all logs; both-set is
  // ambiguous (and the evaluator only runs the inline query today).
  private assertQuerySource(savedQueryId: string | null, query: RuleQuery): void {
    const hasSaved = savedQueryId != null;
    const hasQuery = hasInlineQuery(query);
    if (hasSaved === hasQuery) {
      throw new ValidationError('provide exactly one of: savedQueryId, or a non-empty query');
    }
  }
}

// hasInlineQuery reports whether an inline query carries at least one filter. An
// empty query would count every event in the window (no predicate) and spuriously
// fire — mirrors the Go evaluator's RuleQuery.IsEmpty and the contract helper.
function hasInlineQuery(query: RuleQuery): boolean {
  return Boolean(
    query.text?.trim() ||
      query.service?.trim() ||
      query.level ||
      (query.labels && Object.keys(query.labels).length > 0),
  );
}

function isUniqueName(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
