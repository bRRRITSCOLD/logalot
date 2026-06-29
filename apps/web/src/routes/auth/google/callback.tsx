import { createFileRoute, redirect } from '@tanstack/react-router';
import { Alert } from '../../../components/ui/alert';
import { Spinner } from '../../../components/ui/spinner';
import { completeGoogleSignin, getOidcTenantSlug } from '../../../server/oidc';

// ── /auth/google/callback ──────────────────────────────────────────────────
// Landing route for the Google OIDC redirect.  Google delivers:
//   ?code=<authorization_code>&state=<opaque_state>
// This route exchanges them (via the BFF relay) for session cookies and
// redirects to returnTo (validated relative path) or /app on success.
//
// The tenantSlug is NOT in the URL — it is recovered from the short-lived
// httpOnly cookie set by `startGoogleSignin` at authorize time.  This keeps
// tenant routing off the redirect_uri (which Google echoes verbatim and could
// be compared by clients) and avoids a URL-parameter open-redirect vector.
//
// Error paths render a brief message; no enumeration signal (no
// "workspace not found" vs "invalid code" differentiation).

/**
 * Returns true if `s` contains any C0 control character (U+0000-U+001F) or
 * DEL (U+007F).  Browsers strip certain of these (TAB, LF, CR) while parsing
 * URLs per WHATWG URL §5.1, so "/\t/evil.example" collapses to
 * "//evil.example" — an open redirect.  Checking via charCodeAt matches the
 * same defence applied by `returnToSchema` in @logalot/contracts.
 */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

export const Route = createFileRoute('/auth/google/callback')({
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === 'string' ? search.code : '',
    state: typeof search.state === 'string' ? search.state : '',
    // Google may send `error` when the user denies consent.
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  loaderDeps: ({ search }) => ({ code: search.code, state: search.state, error: search.error }),
  loader: async ({ deps }) => {
    // User denied consent or IdP returned an error.
    if (deps.error) {
      return { ok: false as const, message: 'Sign-in was cancelled or denied.' };
    }

    if (!deps.code || !deps.state) {
      return { ok: false as const, message: 'Invalid callback parameters.' };
    }

    // Recover tenantSlug from the short-lived handshake cookie.
    const tenantSlug = await getOidcTenantSlug();
    if (!tenantSlug) {
      // Cookie absent: flow was not initiated from this browser, or the 10-minute
      // TTL expired.  Fail closed — do not guess the tenant.
      return {
        ok: false as const,
        message: 'Sign-in session expired. Please try signing in again.',
      };
    }

    const result = await completeGoogleSignin({
      data: { tenantSlug, code: deps.code, state: deps.state },
    });

    if (!result.ok) {
      return { ok: false as const, message: result.message };
    }

    // Validate returnTo: apply the same checks as returnToSchema — no absolute
    // or protocol-relative URLs, and no control characters.  The value was
    // schema-validated and stored httpOnly at authorize time, but applying the
    // full check here matches the defence-in-depth parity the contracts layer
    // provides (WHATWG-stripped bytes can re-introduce open-redirect bypasses).
    const destination =
      result.returnTo &&
      /^\/(?![/\\])/.test(result.returnTo) &&
      !hasControlChar(result.returnTo)
        ? result.returnTo
        : '/app';

    throw redirect({ to: destination });
  },
  component: CallbackPage,
});

function CallbackPage() {
  const data = Route.useLoaderData();

  // Happy path: loader redirects before the component renders.
  // This component only renders when an error occurred.
  if (!data.ok) {
    return (
      <div className="flex min-h-svh items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <Alert tone="danger" title="Sign-in failed">
            {data.message}{'  '}
            <a href="/login" className="underline">
              Return to sign-in
            </a>
          </Alert>
        </div>
      </div>
    );
  }

  // Should never be reached (loader redirects on success), but guard the render.
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Spinner aria-label="Completing sign-in…" />
    </div>
  );
}
