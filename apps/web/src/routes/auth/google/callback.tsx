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

    // Validate returnTo: the schema already rejected absolute URLs, but belt-and-
    // suspenders: only follow paths that start with a single '/'.
    const destination =
      result.returnTo && /^\/(?![/\\])/.test(result.returnTo) ? result.returnTo : '/app';

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
            {data.message}{' '}
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
