import { z } from 'zod';
import { uuidSchema } from './ids.js';

/**
 * Alerting contracts (shared by the control-plane CRUD and the admin UI). The
 * alert-evaluator (a Go worker) reads these same rows but is not a TypeScript
 * consumer; the shapes here mirror the `alert_rules` table (migrations 000009 +
 * 000013) so request/response shapes never drift from backend or frontend.
 */

/** Log severity, mirrors the Postgres `log_level` enum (migration 000002). */
export const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export type LogLevel = z.infer<typeof logLevelSchema>;

/** How the observed match count is compared to the threshold (`alert_comparator`). */
export const alertComparatorSchema = z.enum(['gt', 'gte', 'lt', 'lte', 'eq']);
export type AlertComparator = z.infer<typeof alertComparatorSchema>;

/** Lifecycle state, mirrors the Postgres `alert_state` enum. System-managed by the
 *  evaluator — never settable through the API. */
export const alertStateSchema = z.enum(['ok', 'firing', 'no_data']);
export type AlertState = z.infer<typeof alertStateSchema>;

/** Rule severity label (free-text in the DB; constrained to a closed set at the API). */
export const alertSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;

/**
 * The structured query a rule evaluates over its window — the same flat filter
 * language the hot store uses (full-text + service/level equality + label
 * containment). No time range here: the evaluator derives it from windowSeconds.
 */
export const ruleQuerySchema = z
  .object({
    text: z.string().trim().max(1000).optional(),
    service: z.string().trim().max(200).optional(),
    level: logLevelSchema.optional(),
    labels: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type RuleQuery = z.infer<typeof ruleQuerySchema>;

/**
 * Whether an inline query carries at least one filter. An EMPTY inline query
 * would make the evaluator count every event in the window (no predicate) and
 * spuriously fire, so an empty query is never a valid rule source. Mirrors the
 * Go evaluator's RuleQuery.IsEmpty.
 */
export function hasInlineQuery(query: RuleQuery | undefined): boolean {
  if (!query) return false;
  return Boolean(
    query.text?.trim() ||
      query.service?.trim() ||
      query.level ||
      (query.labels && Object.keys(query.labels).length > 0),
  );
}

/**
 * A notification target. v1: webhook (SNS -> HTTPS fan-out) | email (real SMTP
 * send in the alert-evaluator, retiring the old floci email-stub — issue #187).
 */
export const notifyChannelSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('webhook'), url: z.string().url().max(2000) }).strict(),
  z.object({ type: z.literal('email'), to: z.string().email().max(320) }).strict(),
]);
export type NotifyChannel = z.infer<typeof notifyChannelSchema>;

export const createAlertRuleRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    // A rule's query source is EXACTLY ONE of: a saved query reference, OR a
    // non-empty inline query (XOR below). An empty query would count all logs and
    // spuriously fire (review I2); saved-query resolution is a documented follow-up.
    savedQueryId: uuidSchema.optional(),
    query: ruleQuerySchema.default({}),
    comparator: alertComparatorSchema.default('gt'),
    // Non-negative match-count threshold. `finite` rejects NaN/Infinity.
    threshold: z.number().finite().nonnegative(),
    windowSeconds: z.number().int().min(30).max(86400).default(300),
    severity: alertSeveritySchema.default('warning'),
    enabled: z.boolean().default(true),
    notifyChannels: z.array(notifyChannelSchema).max(20).default([]),
  })
  .strict()
  .refine((v) => (v.savedQueryId !== undefined) !== hasInlineQuery(v.query), {
    message: 'provide exactly one of: savedQueryId, or a non-empty query',
    path: ['query'],
  });
export type CreateAlertRuleRequest = z.infer<typeof createAlertRuleRequestSchema>;

/** Partial update. State/evaluation fields are evaluator-owned and not updatable. */
export const updateAlertRuleRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    savedQueryId: uuidSchema.nullable().optional(),
    query: ruleQuerySchema.optional(),
    comparator: alertComparatorSchema.optional(),
    threshold: z.number().finite().nonnegative().optional(),
    windowSeconds: z.number().int().min(30).max(86400).optional(),
    severity: alertSeveritySchema.optional(),
    enabled: z.boolean().optional(),
    notifyChannels: z.array(notifyChannelSchema).max(20).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field must be provided' })
  // If the inline query is being changed, it cannot be blanked to empty (that
  // would make the rule match all logs). To switch to a saved query, set
  // savedQueryId in the same patch.
  .refine((v) => v.query === undefined || hasInlineQuery(v.query) || v.savedQueryId !== undefined, {
    message: 'query cannot be emptied; set a savedQueryId to switch query source',
    path: ['query'],
  });
export type UpdateAlertRuleRequest = z.infer<typeof updateAlertRuleRequestSchema>;

export const alertRuleResponseSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  name: z.string(),
  savedQueryId: uuidSchema.nullable(),
  query: ruleQuerySchema,
  comparator: alertComparatorSchema,
  threshold: z.number(),
  windowSeconds: z.number(),
  severity: z.string(),
  enabled: z.boolean(),
  notifyChannels: z.array(notifyChannelSchema),
  // Evaluator-managed, read-only.
  state: alertStateSchema,
  lastEvaluatedAt: z.string().nullable(),
  lastTriggeredAt: z.string().nullable(),
  createdBy: uuidSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AlertRuleResponse = z.infer<typeof alertRuleResponseSchema>;
