import { z } from 'zod';
import { uuidSchema } from './ids.js';

/**
 * Dashboard contracts (shared by the control-plane CRUD and the admin UI).
 * A Dashboard OWNS its panels inline as JSONB (panels have no identity or lifecycle
 * outside their dashboard — proper aggregate boundary, migration 000008). Panels
 * reference saved_queries by id only (cross-aggregate by identity, no FK).
 *
 * Layout shape:
 *   { "panels": [ { "id":"p1", "type":"timeseries", "title":"5xx rate",
 *                   "savedQueryId":"<uuid>", "viz":{...}, "grid":{x,y,w,h} } ] }
 */

/** Grid position/size for a panel. */
export const panelGridSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
  })
  .strict();
export type PanelGrid = z.infer<typeof panelGridSchema>;

/** Supported panel visualization types (YAGNI: only timeseries + stat for v1). */
export const panelTypeSchema = z.enum(['timeseries', 'stat', 'logs']);
export type PanelType = z.infer<typeof panelTypeSchema>;

/**
 * A single panel definition. Each panel references a saved query by id; the query
 * drives what data is displayed. `viz` is a free-form object for type-specific
 * display options (unit, color scheme, etc.) — validated loose to avoid breaking
 * new types before the schema evolves.
 */
export const panelSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    type: panelTypeSchema,
    title: z.string().trim().min(1).max(200),
    savedQueryId: uuidSchema,
    viz: z.record(z.string(), z.unknown()).default({}),
    grid: panelGridSchema,
  })
  .strict();
export type Panel = z.infer<typeof panelSchema>;

/** The dashboard layout: an ordered list of panels. */
export const dashboardLayoutSchema = z
  .object({
    panels: z.array(panelSchema).max(50),
  })
  .strict();
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

export const createDashboardRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    layout: dashboardLayoutSchema.default({ panels: [] }),
  })
  .strict();
export type CreateDashboardRequest = z.infer<typeof createDashboardRequestSchema>;

export const updateDashboardRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    layout: dashboardLayoutSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field must be provided' });
export type UpdateDashboardRequest = z.infer<typeof updateDashboardRequestSchema>;

export const dashboardResponseSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  layout: dashboardLayoutSchema,
  createdBy: uuidSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
