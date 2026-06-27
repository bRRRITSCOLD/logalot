import type { Pool } from 'pg';
import type { AlertRulePatch, AlertRuleRepository, NewAlertRule } from '../../app/ports';
import type {
  AlertComparator,
  AlertRule,
  AlertState,
  NotifyChannel,
  RuleQuery,
} from '../../domain/entities';
import { withTenantTx } from './tenant-tx';

interface AlertRuleRow {
  id: string;
  tenant_id: string;
  name: string;
  saved_query_id: string | null;
  query: RuleQuery;
  comparator: AlertComparator;
  threshold: string; // numeric comes back as a string from node-postgres
  window_seconds: number;
  severity: string;
  enabled: boolean;
  notify_channels: NotifyChannel[];
  state: AlertState;
  last_evaluated_at: Date | null;
  last_triggered_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function toRule(row: AlertRuleRow): AlertRule {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    savedQueryId: row.saved_query_id,
    query: row.query ?? {},
    comparator: row.comparator,
    threshold: Number(row.threshold),
    windowSeconds: row.window_seconds,
    severity: row.severity,
    enabled: row.enabled,
    notifyChannels: row.notify_channels ?? [],
    state: row.state,
    lastEvaluatedAt: row.last_evaluated_at,
    lastTriggeredAt: row.last_triggered_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = `id, tenant_id, name, saved_query_id, query, comparator, threshold,
  window_seconds, severity, enabled, notify_channels, state,
  last_evaluated_at, last_triggered_at, created_by, created_at, updated_at`;

// PgAlertRuleRepository persists alert_rules under tenant RLS (as the NOSUPERUSER
// logalot_app role). It writes only the CONFIG columns; state/evaluation columns
// are owned by the alert-evaluator worker and never touched here. tenant_id is
// stamped from the armed context, so the WITH CHECK policy admits the row only for
// the acting tenant — a body-asserted tenant is impossible.
export class PgAlertRuleRepository implements AlertRuleRepository {
  constructor(private readonly pool: Pool) {}

  async create(tenantId: string, input: NewAlertRule): Promise<AlertRule> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<AlertRuleRow>(
        `INSERT INTO alert_rules
           (tenant_id, name, saved_query_id, query, comparator, threshold,
            window_seconds, severity, enabled, notify_channels, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5::alert_comparator, $6,
                 $7, $8, $9, $10::jsonb, $11)
         RETURNING ${COLUMNS}`,
        [
          tenantId,
          input.name,
          input.savedQueryId,
          JSON.stringify(input.query ?? {}),
          input.comparator,
          input.threshold,
          input.windowSeconds,
          input.severity,
          input.enabled,
          JSON.stringify(input.notifyChannels ?? []),
          input.createdBy,
        ],
      );
      return toRule(res.rows[0] as AlertRuleRow);
    });
  }

  async list(tenantId: string): Promise<AlertRule[]> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<AlertRuleRow>(
        `SELECT ${COLUMNS} FROM alert_rules ORDER BY created_at DESC`,
      );
      return res.rows.map(toRule);
    });
  }

  async findById(tenantId: string, id: string): Promise<AlertRule | null> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query<AlertRuleRow>(
        `SELECT ${COLUMNS} FROM alert_rules WHERE id = $1`,
        [id],
      );
      const row = res.rows[0];
      return row ? toRule(row) : null;
    });
  }

  async update(tenantId: string, id: string, patch: AlertRulePatch): Promise<AlertRule | null> {
    // Build a partial UPDATE from only the provided fields. Each value is a bound
    // parameter; column names come from a fixed allow-list (no injection surface).
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, value: unknown, cast = ''): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}${cast}`);
    };

    if (patch.name !== undefined) add('name', patch.name);
    if (patch.savedQueryId !== undefined) add('saved_query_id', patch.savedQueryId);
    if (patch.query !== undefined) add('query', JSON.stringify(patch.query), '::jsonb');
    if (patch.comparator !== undefined) add('comparator', patch.comparator, '::alert_comparator');
    if (patch.threshold !== undefined) add('threshold', patch.threshold);
    if (patch.windowSeconds !== undefined) add('window_seconds', patch.windowSeconds);
    if (patch.severity !== undefined) add('severity', patch.severity);
    if (patch.enabled !== undefined) add('enabled', patch.enabled);
    if (patch.notifyChannels !== undefined)
      add('notify_channels', JSON.stringify(patch.notifyChannels), '::jsonb');

    if (sets.length === 0) {
      // Nothing to change — return the current row (the service guards against this,
      // but keep the repo total).
      return this.findById(tenantId, id);
    }

    return withTenantTx(this.pool, tenantId, async (client) => {
      params.push(id);
      const res = await client.query<AlertRuleRow>(
        `UPDATE alert_rules SET ${sets.join(', ')} WHERE id = $${params.length}
         RETURNING ${COLUMNS}`,
        params,
      );
      const row = res.rows[0];
      return row ? toRule(row) : null;
    });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const res = await client.query(`DELETE FROM alert_rules WHERE id = $1`, [id]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
