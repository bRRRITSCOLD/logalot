import { z } from 'zod';
import { uuidSchema } from './ids.js';

/**
 * Scopes an API key may carry (ADR-0007, #82).
 *
 * - `ingest:write` — grants log ingest (POST /v1/ingest). Default for new
 *   keys. Does NOT grant log reads as of #82 (the back-compat grant from #76
 *   has been retired).
 * - `logs:read`   — grants log-content reads (search, live-tail, panel-data).
 *   The contract and the control-plane API accept `logs:read`, so read-only
 *   consumers (dashboards, CI log viewers, etc.) can be minted via the API.
 *   NOTE: the admin web UI key-create form still hardcodes `ingest:write` and
 *   has no scope selector yet — surfacing `logs:read` in the UI is a tracked
 *   follow-up. Ingest+read keys should carry both scopes.
 */
export const scopeSchema = z.enum(['ingest:write', 'logs:read']);
export type Scope = z.infer<typeof scopeSchema>;

export const createApiKeyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    // Default to ingest:write — ingest keys remain the common case.
    // Read-only consumers should explicitly request ['logs:read'] (accepted by
    // the API today; UI scope selection is a tracked follow-up).
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
