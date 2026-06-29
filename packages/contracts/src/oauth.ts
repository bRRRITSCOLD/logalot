import { z } from 'zod';
import { tenantPublicIdSchema } from './tenant.js';

/**
 * Returns true if `v` contains any C0 control character (U+0000-U+001F) or
 * DEL (U+007F).
 *
 * Browsers strip TAB (U+0009), LF (U+000A), and CR (U+000D) while parsing
 * URLs (WHATWG URL spec §5.1), so "/\t/evil.example" collapses to
 * "//evil.example" — an open redirect.  Checking via charCodeAt avoids
 * embedding actual control characters in a regex literal (Biome
 * noControlCharactersInRegex) or a RegExp constructor call (Biome
 * useRegexLiterals).
 */
function containsControlChar(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const code = v.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * returnTo must be a relative path starting with a single `/` (not `//` or
 * `/\`).  We use an allow-list regex after trimming so that leading whitespace
 * or control characters cannot smuggle in an absolute URL or protocol-relative
 * path — common open-redirect bypasses that a deny-list cannot enumerate
 * exhaustively.
 *
 * Embedded C0 control characters (U+0000-U+001F) and DEL (U+007F) are also
 * rejected.  Browsers strip TAB (U+0009), LF (U+000A), and CR (U+000D) while
 * parsing URLs (WHATWG URL spec §5.1), so a value like "/\t/evil.example"
 * collapses to "//evil.example" in the browser — an open redirect.  Rejecting
 * all C0/DEL characters closes this bypass regardless of which specific bytes
 * a future parser may strip.
 *
 * Valid:   `/dashboard`, `/tenant/acme/logs?page=2`
 * Invalid: `https://evil.example`, `//evil.example`, `/\evil`, ` https://evil`,
 *          `/\t/evil.example`, `/\n//evil`, `/\r/evil`
 */
const returnToSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (v) => /^\/(?![/\\])/.test(v) && !containsControlChar(v),
    'returnTo must be a relative path starting with a single "/" and must not contain control characters',
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
