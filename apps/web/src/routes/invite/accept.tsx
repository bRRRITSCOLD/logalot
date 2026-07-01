import { createFileRoute, redirect } from '@tanstack/react-router';
import * as React from 'react';
import { Alert } from '../../components/ui/alert';
import { Spinner } from '../../components/ui/spinner';
import { getInviteTenantSlug, startGoogleSignin, stashInviteToken } from '../../server/oidc';

// ── /invite/accept ───────────────────────────────────────────────────────────
// Public landing route for an invite link: `/invite/accept?token=lginv_<slug>_<secret>`.
//
// Two-pass flow:
//   1. First hit (token present in the URL): `beforeLoad` immediately moves the
//      token into the httpOnly `lg_invite_token` cookie and sets
//      `Referrer-Policy: no-referrer` (both via `stashInviteToken`), then
//      redirects (replace, no search) to this SAME route with a clean URL —
//      the token never lingers in the address bar or browser history (R-INV-11).
//   2. Second hit (no token in the URL): the loader recovers the NON-SECRET
//      tenant slug from the stashed cookie (`getInviteTenantSlug`) and the
//      component immediately starts the Google sign-in flow scoped to that
//      tenant — the invitee never types or supplies a workspace (R-INV-20).
//      The invite token itself stays in the cookie; it is picked up later by
//      `completeGoogleSignin` and relayed to the control-plane in the request
//      BODY only (R-INV-12), never in the redirect to Google.
//
// Any invitee-supplied query params other than `token` (e.g. `tenant`,
// `returnTo`) are never read by this route, so they cannot influence tenant
// routing or the post-login destination — the default `/app` fallback in the
// Google callback route applies (R-INV-20).

export const Route = createFileRoute('/invite/accept')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' && search.token.length > 0 ? search.token : undefined,
  }),
  beforeLoad: async ({ search }) => {
    if (search.token) {
      // Best-effort: even a malformed token still gets stripped from the URL.
      // The second pass fails closed if nothing usable ended up in the cookie.
      await stashInviteToken({ data: { token: search.token } });
      throw redirect({ to: '/invite/accept', search: { token: undefined }, replace: true });
    }
  },
  loader: async () => ({ tenantSlug: await getInviteTenantSlug() }),
  component: RouteComponent,
});

function RouteComponent() {
  const { tenantSlug } = Route.useLoaderData();
  return <InviteAcceptPage tenantSlug={tenantSlug} />;
}

export interface InviteAcceptPageProps {
  /**
   * The NON-SECRET tenant slug recovered from the stashed `lg_invite_token`
   * cookie, or `null` when no usable invite token was found (missing,
   * expired, or malformed) — the invitee cannot supply their own value.
   */
  tenantSlug: string | null;
}

// Exported (undecorated by the route/loader) so it can be exercised directly
// in component tests without standing up a full TanStack Router instance.
export function InviteAcceptPage({ tenantSlug }: InviteAcceptPageProps) {
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!tenantSlug) {
      setError('This invite link is invalid or has expired.');
      return;
    }

    let cancelled = false;
    void (async () => {
      const result = await startGoogleSignin({ data: { tenantSlug } });
      if (cancelled) return;
      if (result.ok) {
        // External navigation — the invite token is never part of this URL.
        window.location.href = result.redirectUrl;
      } else {
        setError(result.message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tenantSlug]);

  if (error) {
    return (
      <div className="flex min-h-svh items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <Alert tone="danger" title="Invite link invalid">
            {error}
            {'  '}
            <a href="/login" className="underline">
              Go to sign-in
            </a>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Spinner aria-label="Accepting invite…" />
    </div>
  );
}
