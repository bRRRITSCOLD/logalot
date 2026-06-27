import { z } from 'zod';
import { uuidSchema } from './ids.js';
import { roleSchema } from './roles.js';
import { tenantPublicIdSchema } from './tenant.js';

/**
 * Login. Email is unique only WITHIN a tenant (`users UNIQUE (tenant_id,email)`),
 * so the tenant slug disambiguates which tenant the user is authenticating into.
 */
export const loginRequestSchema = z
  .object({
    tenantSlug: tenantPublicIdSchema,
    email: z.string().email().max(320),
    password: z.string().min(1).max(200),
  })
  .strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const refreshRequestSchema = z.object({ refreshToken: z.string().min(1) }).strict();
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const logoutRequestSchema = z.object({ refreshToken: z.string().min(1) }).strict();
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;

/** Token pair returned by /login and /refresh. */
export const tokenPairSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  // access-token lifetime in seconds.
  expiresIn: z.number().int().positive(),
  tokenType: z.literal('Bearer'),
  role: roleSchema,
  tenantId: uuidSchema,
  userId: uuidSchema,
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

/** Verified access-JWT claims. `sub` = users.id. */
export const accessClaimsSchema = z.object({
  sub: uuidSchema,
  tenant_id: uuidSchema,
  role: roleSchema,
  iat: z.number().int(),
  exp: z.number().int(),
});
export type AccessClaims = z.infer<typeof accessClaimsSchema>;
