import { z } from 'zod';
import { uuidSchema } from './ids.js';

/**
 * Per-tenant retention policy contracts (1:1 with a tenant). Shared by the
 * control-plane CRUD and the admin UI so request/response shapes never drift.
 * Bounds mirror migration 000006 (hot 1..90 days; cold 1..36500 days) and the
 * invariant that cold retention is at least as long as hot.
 */
export const upsertRetentionRequestSchema = z
  .object({
    hotDays: z.number().int().min(1).max(90),
    coldDays: z.number().int().min(1).max(36500),
  })
  .strict()
  .refine((v) => v.coldDays >= v.hotDays, {
    message: 'coldDays must be >= hotDays',
    path: ['coldDays'],
  });
export type UpsertRetentionRequest = z.infer<typeof upsertRetentionRequestSchema>;

export const retentionResponseSchema = z.object({
  tenantId: uuidSchema,
  hotDays: z.number(),
  coldDays: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RetentionResponse = z.infer<typeof retentionResponseSchema>;
