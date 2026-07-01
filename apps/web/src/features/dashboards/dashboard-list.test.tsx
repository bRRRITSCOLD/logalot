import type { DashboardResponse, Role } from '@logalot/contracts';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../../hooks/use-session';
import type { DashboardOutcome } from '../../server/dashboards';
import { sessionForRole } from '../test-utils';
import { DashboardList, type DashboardListProps } from './dashboard-list';

function dashboard(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    id: '00000000-0000-0000-0000-0000000000f1',
    tenantId: '00000000-0000-0000-0000-0000000000aa',
    name: 'Errors overview',
    description: 'Tracks 5xx rates',
    layout: { panels: [] },
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const ok = <T,>(data: T): DashboardOutcome<T> => ({ ok: true, data });

function makeProps(dashboards: DashboardResponse[] = []) {
  return {
    dashboards,
    create: vi.fn(async (..._a: unknown[]) => ok(dashboard())),
    remove: vi.fn(async (..._a: unknown[]) => ok(undefined)),
    onChanged: vi.fn(),
  };
}

// DashboardList renders a router <Link> to the (future) detail route, so it must
// mount inside a RouterProvider — mirrors app-shell.test.tsx's harness.
function renderList(role: Role, props: DashboardListProps) {
  const rootRoute = createRootRoute({
    component: () => (
      <SessionProvider session={sessionForRole(role)}>
        <DashboardList {...props} />
      </SessionProvider>
    ),
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboards/$dashboardId',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([detailRoute]),
    history: createMemoryHistory({ initialEntries: ['/dashboards'] }),
  });
  render(<RouterProvider router={router as never} />);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DashboardList', () => {
  it('renders the list with a link to each dashboard', async () => {
    renderList('member', makeProps([dashboard()]));
    await waitFor(() => expect(screen.getByText('Errors overview')).toBeInTheDocument());
    expect(screen.getByText('Tracks 5xx rates')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Errors overview' })).toHaveAttribute(
      'href',
      '/dashboards/00000000-0000-0000-0000-0000000000f1',
    );
    expect(screen.getByText('0 panels')).toBeInTheDocument();
  });

  it('renders EmptyState when there are none', async () => {
    renderList('tenant_admin', makeProps([]));
    await waitFor(() => expect(screen.getByText('No dashboards yet')).toBeInTheDocument());
  });

  it('a member sees no New/Delete affordances', async () => {
    renderList('member', makeProps([dashboard()]));
    await waitFor(() => expect(screen.getByText('Errors overview')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'New dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('a tenant_admin sees New/Delete affordances', async () => {
    renderList('tenant_admin', makeProps([dashboard()]));
    await waitFor(() => expect(screen.getByText('Errors overview')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'New dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('creates a dashboard from the New dashboard dialog', async () => {
    const u = userEvent.setup();
    const props = makeProps([dashboard()]);
    renderList('tenant_admin', props);
    await waitFor(() => expect(screen.getByText('Errors overview')).toBeInTheDocument());

    await u.click(screen.getByRole('button', { name: 'New dashboard' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Name'), 'Latency overview');
    await u.click(within(dialog).getByRole('button', { name: 'Create dashboard' }));

    await waitFor(() => expect(props.create).toHaveBeenCalledTimes(1));
    const body = props.create.mock.calls[0]?.[0] as { name: string };
    expect(body.name).toBe('Latency overview');
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('deletes a dashboard after confirmation, then refreshes', async () => {
    const u = userEvent.setup();
    const props = makeProps([dashboard()]);
    renderList('tenant_admin', props);
    await waitFor(() => expect(screen.getByText('Errors overview')).toBeInTheDocument());

    await u.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Delete dashboard' }));

    await waitFor(() => expect(props.remove).toHaveBeenCalledWith(dashboard().id));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('surfaces a failed delete and does not refresh', async () => {
    const u = userEvent.setup();
    const props = makeProps([dashboard()]);
    props.remove = vi.fn(async () => ({
      ok: false as const,
      error: { kind: 'invalid' as const, message: 'Dashboard is still referenced' },
    }));
    renderList('tenant_admin', props);
    await waitFor(() => expect(screen.getByText('Errors overview')).toBeInTheDocument());

    await u.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Delete dashboard' }));

    expect(await within(dialog).findByText('Dashboard is still referenced')).toBeInTheDocument();
    expect(props.onChanged).not.toHaveBeenCalled();
  });
});
