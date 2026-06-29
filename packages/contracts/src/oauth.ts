import { z } from 'zod';
import { tenantPublicIdSchema } from './tenant.js';

/**
 * returnTo must be a relative path starting with a single `/` (not `//` or
 * `/\`).  We use an allow-list regex after trimming so that leading whitespace
 * or control characters cannot smuggle in an absolute URL or protocol-relative
 * path — common open-redirect bypasses that a deny-list cannot enumerate
 * exhaustively.
 *
 * Valid:   `/dashboard`, `/tenant/acme/logs?page=2`
 * Invalid: `https://evil.example`, `//evil.example`, `/\evil`, ` https://evil`
 */
const returnToSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (v) => /^\/(?![/\\])/.test(v),
    'returnTo must be a relative path starting with a single "/"',
  );

/**
 * oidcAuthorizeRequest — sent by the client (web app) to the control-plane
 * `/auth/oidc/:tenantSlug/authorize` endpoint to initiate the OIDC flow.
 *
 * `tenantSlug` identifies which tenant's IdP to redirect to and is required
 * in the request body. `returnTo` optionally preserves the originally
 * requested URL so the user lands on the right page after login.
 */
export const oidcAuthorizeRequestSchema = z
  .object({
    tenantSlug: tenantPublicIdSchema,
    /** Relative URL to redirect the user to after a successful login. */
    returnTo: returnToSchema.optional(),
  })
  .strict();
export type OidcAuthorizeRequest = z.infer<typeof oidcAuthorizeRequestSchema>;

/**
 * oidcAuthorizeResponse — the control-plane responds with a URL the client
 * must redirect the browser to, pointing at the tenant's identity provider.
 */
export const oidcAuthorizeResponseSchema = z
  .object({
    /** Absolute URL of the IdP's authorization endpoint with all OIDC params. */
    redirectUrl: z.string().url(),
  })
  .strict();
export type OidcAuthorizeResponse = z.infer<typeof oidcAuthorizeResponseSchema>;

/**
 * oidcCallbackRequest — parameters the IdP delivers to the control-plane
 * callback endpoint (`/auth/oidc/:tenantSlug/callback`) via query string.
 *
 * RFC 6749 §4.1.2 / OIDC Core §3.1.2.5: the authorization server MUST
 * return `code` and `state`; both are non-empty opaque strings.
 */
export const oidcCallbackRequestSchema = z
  .object({
    tenantSlug: tenantPublicIdSchema,
    /** Authorization code issued by the IdP — exchanged for tokens server-side. */
    code: z.string().min(1).max(4096),
    /**
     * Opaque value echoed from the original authorization request; the
     * server validates it against the session to prevent CSRF.
     */
    state: z.string().min(1).max(1024),
  })
  .strict();
export type OidcCallbackRequest = z.infer<typeof oidcCallbackRequestSchema>;
