import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Component tests for the invite-accept landing page. The route file's
// beforeLoad/loader wiring (which calls the real server functions and issues
// the URL-stripping redirect) is exercised via oidc.test.ts server-fn tests;
// this file covers the CLIENT behaviour once a `tenantSlug` (or `null`) has
// already been resolved — starting the Google flow scoped to that tenant and
// never letting an invitee-supplied param override it (R-INV-20).

const mockStartGoogleSignin = vi.fn();
vi.mock('../../server/oidc', () => ({
  startGoogleSignin: (...args: unknown[]) => mockStartGoogleSignin(...args),
  stashInviteToken: vi.fn(),
  getInviteTenantSlug: vi.fn(),
}));

import { InviteAcceptPage } from './accept';

const ORIGINAL_LOCATION = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom's window.location.href setter throws "Not implemented: navigation"
  // unless replaced — stub it so the redirect assertion can inspect it.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...ORIGINAL_LOCATION, href: '' },
  });
});
afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: ORIGINAL_LOCATION,
  });
});

describe('InviteAcceptPage', () => {
  it('starts Google sign-in scoped to the resolved tenantSlug and redirects to the IdP URL', async () => {
    mockStartGoogleSignin.mockResolvedValue({
      ok: true,
      redirectUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=s1',
    });

    render(<InviteAcceptPage tenantSlug="acme-corp" />);

    await waitFor(() => {
      expect(mockStartGoogleSignin).toHaveBeenCalledWith({ data: { tenantSlug: 'acme-corp' } });
    });
    await waitFor(() => {
      expect(window.location.href).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=s1',
      );
    });
  });

  it('never forwards any value other than the resolved tenantSlug (no invitee-suppliable field)', async () => {
    mockStartGoogleSignin.mockResolvedValue({
      ok: true,
      redirectUrl: 'https://accounts.google.com/x',
    });

    render(<InviteAcceptPage tenantSlug="acme-corp" />);

    await waitFor(() => expect(mockStartGoogleSignin).toHaveBeenCalled());
    // Exactly one argument: { tenantSlug } — no returnTo, no tenant override.
    expect(mockStartGoogleSignin).toHaveBeenCalledWith({ data: { tenantSlug: 'acme-corp' } });
  });

  it('shows an invalid-link error and never calls startGoogleSignin when tenantSlug is null', async () => {
    render(<InviteAcceptPage tenantSlug={null} />);

    expect(await screen.findByText(/invite link is invalid or has expired/i)).toBeInTheDocument();
    expect(mockStartGoogleSignin).not.toHaveBeenCalled();
    expect(window.location.href).toBe('');
  });

  it('shows the returned message and does not redirect when startGoogleSignin fails', async () => {
    mockStartGoogleSignin.mockResolvedValue({
      ok: false,
      message: 'Sign-in with Google is unavailable for this workspace.',
    });

    render(<InviteAcceptPage tenantSlug="acme-corp" />);

    expect(
      await screen.findByText('Sign-in with Google is unavailable for this workspace.'),
    ).toBeInTheDocument();
    expect(window.location.href).toBe('');
  });

  it('renders a spinner while the sign-in redirect is pending', () => {
    mockStartGoogleSignin.mockReturnValue(new Promise(() => {})); // never resolves
    render(<InviteAcceptPage tenantSlug="acme-corp" />);
    expect(screen.getByRole('status', { name: /accepting invite/i })).toBeInTheDocument();
  });
});
