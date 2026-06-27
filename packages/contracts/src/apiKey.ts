import { z } from 'zod';
import { uuidSchema } from './ids.js';

/**
 * Scopes an API key may carry. v1 is ingest-only (ADR-0007); `ingest:write` is
 * the default and the only scope the ingest Authenticator acts on.
 */
export const scopeSchema = z.enum(['ingest:write']);
export type Scope = z.infer<typeof scopeSchema>;

export const createApiKeyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    scopes: z.array(scopeSchema).nonempty().default(['ingest:write']),
    // ISO-8601 instant; optional expiry.
    expiresAt: z.string().datetime().optional(),
  })
  .strict();
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;

/** Metadata view — never includes the secret or the hash. Used by list/get. */
export const apiKeyResponseSchema = z.object({
  id: z.string(),
  tenantId: uuidSchema,
  name: z.string(),
  scopes: z.array(scopeSchema),
  createdBy: uuidSchema.nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiKeyResponse = z.infer<typeof apiKeyResponseSchema>;

/**
 * Issue response: the metadata PLUS the one-time plaintext. The `plaintext`
 * (`lgk_<publicId>_<keyId>_<secret>`) is shown exactly once and is never stored
 * or logged.
 */
export const apiKeyCreatedResponseSchema = apiKeyResponseSchema.extend({
  plaintext: z.string(),
});
export type ApiKeyCreatedResponse = z.infer<typeof apiKeyCreatedResponseSchema>;
