import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ClientSession } from '../../server/session';
import { AppShell, type AppShellProps } from './app-shell';

const session: ClientSession = {
  userId: '00000000-0000-0000-0000-000000000001',
  tenantId: '00000000-0000-0000-0000-0000000000aa',
  role: 'tenant_admin',
  expiresAt: 2_000_000_000,
};

// AppShell uses router <Link>s, so it must mount inside a RouterProvider. We build
// a tiny in-memory router whose root renders the shell with the test's props.
async function renderShell(props: Partial<AppShellProps> = {}) {
  const rootRoute = createRootRoute({
    component: () => (
      <AppShell session={props.session ?? session} onLogout={props.onLogout ?? (() => {})}>
        <p>Page content</p>
      </AppShell>
    ),
  });
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/app',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([appRoute]),
    history: createMemoryHistory({ initialEntries: ['/app'] }),
  });
  // The test router is structurally compatible with RouterProvider's contract.
  render(<RouterProvider router={router as never} />);
  await waitFor(() => expect(screen.getByText('Page content')).toBeInTheDocument());
}

describe('AppShell', () => {
  it('renders the primary navigation, brand, and page content', async () => {
    await renderShell();
    expect(screen.getAllByRole('navigation', { name: 'Primary' }).length).toBeGreaterThan(0);
    // Overview, Log Explorer (#21), Search (#22), and now Alerts + Admin (#23)
    // are all live nav links — no disabled placeholders remain.
    expect(screen.getAllByText('Overview').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Log Explorer' })[0]).toHaveAttribute(
      'href',
      '/explorer',
    );
    // Search links to the explorer surface with the search mode selected.
    expect(screen.getAllByRole('link', { name: 'Search' })[0]).toHaveAttribute(
      'href',
      expect.stringContaining('/explorer'),
    );
    expect(screen.getAllByRole('link', { name: 'Alerts' })[0]).toHaveAttribute('href', '/alerts');
    expect(screen.getAllByRole('link', { name: 'Admin' })[0]).toHaveAttribute('href', '/admin');
    // No nav item is a disabled placeholder anymore.
    expect(screen.queryByText('soon')).not.toBeInTheDocument();
  });

  it('surfaces the server-derived role from the session', async () => {
    await renderShell();
    expect(screen.getAllByText('tenant_admin').length).toBeGreaterThan(0);
  });

  it('opens the mobile drawer from the menu button (aria-expanded toggles)', async () => {
    const user = userEvent.setup();
    await renderShell();
    const menuButton = screen.getByRole('button', { name: 'Open navigation menu' });
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');

    await user.click(menuButton);
    expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    // A close control appears inside the opened drawer.
    expect(screen.getAllByRole('button', { name: 'Close navigation menu' }).length).toBeGreaterThan(
      0,
    );
  });

  it('invokes onLogout when Sign out is clicked', async () => {
    const onLogout = vi.fn();
    const user = userEvent.setup();
    await renderShell({ onLogout });
    const [signOut] = screen.getAllByRole('button', { name: /sign out/i });
    await user.click(signOut as HTMLElement);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
