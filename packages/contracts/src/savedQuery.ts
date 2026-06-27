import { z } from 'zod';
import { logLevelSchema } from './alertRule.js';
import { uuidSchema } from './ids.js';

/**
 * SavedQuery contracts (shared by the control-plane CRUD and the admin UI).
 * A SavedQuery is a reusable, tenant-owned query definition: a full-text string
 * plus structured filters and an optional time range. It is referenced BY IDENTITY
 * from dashboards (panel.savedQueryId) and alert_rules (savedQueryId) — no FK.
 * Schema mirrors the `saved_queries` table (migration 000007).
 */

/**
 * Structured label/field filters (the same predicate language as RuleQuery, minus
 * `text` which lives in `query_text`). Stored as `filters` jsonb.
 */
export const savedQueryFiltersSchema = z
  .object({
    service: z.string().trim().max(200).optional(),
    level: logLevelSchema.optional(),
    labels: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type SavedQueryFilters = z.infer<typeof savedQueryFiltersSchema>;

/**
 * Time range: either relative (e.g. {"relative":"24h"}) or absolute
 * ({"from":"<RFC3339>","to":"<RFC3339>"}). Stored as `time_range` jsonb.
 * Either relative or both from+to must be provided when non-empty.
 */
export const savedQueryTimeRangeSchema = z.union([
  z.object({ relative: z.string().trim().min(1).max(50) }).strict(),
  z
    .object({ from: z.string(), to: z.string() })
    .strict()
    .refine((v) => v.from < v.to, { message: "'from' must be before 'to'" }),
  z.object({}).strict(), // empty = no time constraint (the panel/alert controls the window)
]);
export type SavedQueryTimeRange = z.infer<typeof savedQueryTimeRangeSchema>;

export const createSavedQueryRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    queryText: z.string().max(1000).default(''),
    filters: savedQueryFiltersSchema.default({}),
    timeRange: savedQueryTimeRangeSchema.default({}),
  })
  .strict();
export type CreateSavedQueryRequest = z.infer<typeof createSavedQueryRequestSchema>;

export const updateSavedQueryRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    queryText: z.string().max(1000).optional(),
    filters: savedQueryFiltersSchema.optional(),
    timeRange: savedQueryTimeRangeSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field must be provided' });
export type UpdateSavedQueryRequest = z.infer<typeof updateSavedQueryRequestSchema>;

export const savedQueryResponseSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  queryText: z.string(),
  filters: savedQueryFiltersSchema,
  timeRange: z.record(z.string(), z.unknown()),
  createdBy: uuidSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedQueryResponse = z.infer<typeof savedQueryResponseSchema>;
