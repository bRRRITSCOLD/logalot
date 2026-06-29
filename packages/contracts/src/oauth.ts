import { z } from 'zod';
import { tenantPublicIdSchema } from './tenant.js';

/**
 * returnTo must be a relative path — absolute URLs, protocol-relative `//`,
 * and Windows-style `\\` paths are all rejected to prevent open-redirect
 * attacks after the OIDC callback completes.
 *
 * Valid: `/dashboard`, `/tenant/acme/logs`
 * Invalid: `https://evil.example`, `//evil.example`, `\\evil`
 */
const returnToSchema = z
  .string()
  .min(1)
  .max(2000)
  .refine(
    (v) =>
      !v.startsWith('//') &&
      !v.startsWith('\\') &&
      !/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(v), // no scheme (absolute URL)
    'returnTo must be a relative path — absolute URLs and protocol-relative paths are not allowed',
  );

/**
 * oidcAuthorizeRequest — sent by the client (web app) to the control-plane
 * `/auth/oidc/:tenantSlug/authorize` endpoint to initiate the OIDC flow.
 *
 * tenantSlug is in the URL path so it surfaces as a query/body param here
 * only when the caller needs to pass it out-of-band (e.g. in query string
 * before the redirect). The authoritative value always comes from the URL.
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
    code: z.string().min(1),
    /**
     * Opaque value echoed from the original authorization request; the
     * server validates it against the session to prevent CSRF.
     */
    state: z.string().min(1),
  })
  .strict();
export type OidcCallbackRequest = z.infer<typeof oidcCallbackRequestSchema>;
