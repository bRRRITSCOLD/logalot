import { z } from 'zod';
import { uuidSchema } from './ids.js';

/**
 * Tenant slug. Mirrors the DB CHECK on `tenants.public_id` (migration 000003):
 * lowercase alnum + hyphens, 3..40 chars, no leading/trailing hyphen. This is
 * the slug embedded in API keys (`lgk_<publicId>_…`, ADR-0007), so the format is
 * load-bearing for ingest compatibility.
 */
export const tenantPublicIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/,
    'must be 3-40 lowercase alnum/hyphen, no edge hyphen',
  );

export const tenantStatusSchema = z.enum(['active', 'suspended', 'deleted']);
export type TenantStatus = z.infer<typeof tenantStatusSchema>;

export const createTenantRequestSchema = z
  .object({
    publicId: tenantPublicIdSchema,
    name: z.string().trim().min(1).max(200),
  })
  .strict();
export type CreateTenantRequest = z.infer<typeof createTenantRequestSchema>;

export const updateTenantRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: tenantStatusSchema.optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.status !== undefined, {
    message: 'at least one of name or status is required',
  });
export type UpdateTenantRequest = z.infer<typeof updateTenantRequestSchema>;

export const tenantResponseSchema = z.object({
  id: uuidSchema,
  publicId: tenantPublicIdSchema,
  name: z.string(),
  status: tenantStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TenantResponse = z.infer<typeof tenantResponseSchema>;
