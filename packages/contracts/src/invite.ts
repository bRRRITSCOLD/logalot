import { z } from 'zod';
import { uuidSchema } from './ids.js';
import { tenantPublicIdSchema } from './tenant.js';

/**
 * Status values an invite may carry over its lifecycle.
 *
 * - `pending`  — issued, not yet consumed
 * - `consumed` — the recipient completed registration via this invite
 * - `revoked`  — cancelled by an admin before consumption
 */
export const inviteStatusSchema = z.enum(['pending', 'consumed', 'revoked']);
export type InviteStatus = z.infer<typeof inviteStatusSchema>;

/**
 * createInviteRequestSchema — body sent by an admin to issue a new invite.
 *
 * R-INV-8: the client may only supply the constrained `role` enum value;
 * no token, secret, or hash is accepted here (`.strict()` rejects extras).
 */
export const createInviteRequestSchema = z
  .object({
    email: z.string().email().max(320),
    /** Defaults to `member`; admins may elevate to `admin`. */
    role: z.enum(['member', 'admin']).default('member'),
  })
  .strict();
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;

/**
 * inviteResponseSchema — metadata view returned by list/get endpoints.
 *
 * Never includes the token, token hash, or any secret material (one-time-secret
 * pattern mirrors apiKey.ts — the secret is surfaced only in
 * `inviteCreatedResponseSchema` at issue time).
 */
export const inviteResponseSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  email: z.string().email(),
  role: z.enum(['member', 'admin']),
  status: inviteStatusSchema,
  expiresAt: z.string(),
  createdBy: uuidSchema.nullable(),
  consumedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InviteResponse = z.infer<typeof inviteResponseSchema>;

/**
 * inviteCreatedResponseSchema — issued when an invite is first created.
 *
 * The `inviteUrl` embeds the one-time plaintext token and is shown exactly
 * once; it is never stored or logged after this response is sent.
 */
export const inviteCreatedResponseSchema = inviteResponseSchema.extend({
  inviteUrl: z.string().url(),
});
export type InviteCreatedResponse = z.infer<typeof inviteCreatedResponseSchema>;

/**
 * inviteListSchema — paginated list of invite metadata records.
 */
export const inviteListSchema = z.object({
  invites: z.array(inviteResponseSchema),
});
export type InviteList = z.infer<typeof inviteListSchema>;

/**
 * Wire format of the one-time invite token: `lginv_<tenantPublicId>_<secret>`
 * (see `services/control-plane/src/domain/invite.ts` for the minting side).
 * Only the prefix + publicId are NON-SECRET; the trailing segment is the
 * high-entropy secret and must never be parsed or logged by this helper.
 */
const INVITE_TOKEN_PREFIX = 'lginv_';

/**
 * parseInviteTenantSlug extracts the NON-SECRET tenant public id embedded in
 * an invite token, without touching the secret component. Used by the web BFF
 * to route the invitee's Google sign-in to the correct tenant (R-INV-20)
 * before the token's secret is ever exchanged with the control-plane.
 *
 * Returns `null` for any malformed input — callers must fail closed rather
 * than guess a tenant.
 */
export function parseInviteTenantSlug(token: string): string | null {
  if (!token.startsWith(INVITE_TOKEN_PREFIX)) {
    return null;
  }
  const rest = token.slice(INVITE_TOKEN_PREFIX.length);
  const sepIdx = rest.indexOf('_');
  // sepIdx <= 0 rejects an empty publicId; === rest.length - 1 rejects an
  // empty secret (both malformed, since the mint side always emits both).
  if (sepIdx <= 0 || sepIdx === rest.length - 1) {
    return null;
  }
  const candidate = rest.slice(0, sepIdx);
  return tenantPublicIdSchema.safeParse(candidate).success ? candidate : null;
}
