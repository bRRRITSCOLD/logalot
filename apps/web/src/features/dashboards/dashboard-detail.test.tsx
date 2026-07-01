import type { DashboardResponse, Role, SavedQueryResponse } from '@logalot/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../../hooks/use-session';
import type { DashboardOutcome } from '../../server/dashboards';
import { sessionForRole } from '../test-utils';
import type { PanelDataOutcome } from './panel-data';

const loadPanelDataFn = vi.fn<(...args: unknown[]) => Promise<PanelDataOutcome>>();
vi.mock('../../server/panel-data', () => ({
  loadPanelDataFn: (...args: unknown[]) => loadPanelDataFn(...args),
}));

const updateDashboardFn =
  vi.fn<(...args: unknown[]) => Promise<DashboardOutcome<DashboardResponse>>>();
vi.mock('../../server/dashboards', () => ({
  updateDashboardFn: (...args: unknown[]) => updateDashboardFn(...args),
}));

// Imported after the mocks are registered.
import { DashboardDetail } from './dashboard-detail';

function dashboard(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    id: '00000000-0000-0000-0000-0000000000f1',
    tenantId: '00000000-0000-0000-0000-0000000000aa',
    name: 'Errors overview',
    description: 'Tracks 5xx rates',
    layout: {
      panels: [
        {
          id: 'p1',
          type: 'timeseries',
          title: '5xx rate',
          savedQueryId: '00000000-0000-0000-0000-0000000000f2',
          viz: {},
          grid: { x: 0, y: 0, w: 4, h: 2 },
        },
      ],
    },
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const savedQueries: SavedQueryResponse[] = [
  {
    id: '00000000-0000-0000-0000-0000000000f2',
    tenantId: '00000000-0000-0000-0000-0000000000aa',
    name: '5xx errors',
    description: null,
    queryText: '',
    filters: {},
    timeRange: {},
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

function renderDetail(role: Role = 'tenant_admin', searchParams = '') {
  return render(
    <NuqsTestingAdapter searchParams={searchParams}>
      <SessionProvider session={sessionForRole(role)}>
        <DashboardDetail dashboard={dashboard()} savedQueries={savedQueries} onChanged={vi.fn()} />
      </SessionProvider>
    </NuqsTestingAdapter>,
  );
}

afterEach(() => {
  loadPanelDataFn.mockReset();
  updateDashboardFn.mockReset();
});

describe('DashboardDetail', () => {
  it('renders the header and the panel grid', async () => {
    loadPanelDataFn.mockResolvedValue({
      ok: true,
      data: { totalCount: 4, buckets: [], recentLogs: [] },
    });

    renderDetail();

    expect(screen.getByRole('heading', { name: 'Errors overview' })).toBeInTheDocument();
    expect(screen.getByText('Tracks 5xx rates')).toBeInTheDocument();
    expect(screen.getByText('5xx rate')).toBeInTheDocument();
    expect(screen.getByText('5xx errors')).toBeInTheDocument();
    await waitFor(() => expect(loadPanelDataFn).toHaveBeenCalledTimes(1));
  });

  it('changing the time range refetches panel data with the new range', async () => {
    loadPanelDataFn.mockResolvedValue({
      ok: true,
      data: { totalCount: 4, buckets: [], recentLogs: [] },
    });
    const u = userEvent.setup();

    renderDetail();
    await waitFor(() => expect(loadPanelDataFn).toHaveBeenCalledTimes(1));

    await u.click(screen.getByRole('button', { name: /select time range|–/i }));
    await u.click(screen.getByRole('button', { name: '15m' }));

    await waitFor(() => expect(loadPanelDataFn).toHaveBeenCalledTimes(2));
    const firstRange = loadPanelDataFn.mock.calls[0]?.[0] as { data: { from: string; to: string } };
    const secondRange = loadPanelDataFn.mock.calls[1]?.[0] as {
      data: { from: string; to: string };
    };
    expect(secondRange.data.from).not.toBe(firstRange.data.from);
    expect(secondRange.data.to).not.toBe(firstRange.data.to);
  });

  it('hides "Edit dashboard" for a role without dashboard:update', () => {
    loadPanelDataFn.mockResolvedValue({
      ok: true,
      data: { totalCount: 4, buckets: [], recentLogs: [] },
    });
    renderDetail('member');
    expect(screen.queryByRole('button', { name: 'Edit dashboard' })).not.toBeInTheDocument();
  });

  it('hides panel authoring controls for a role without dashboard:update', () => {
    loadPanelDataFn.mockResolvedValue({
      ok: true,
      data: { totalCount: 4, buckets: [], recentLogs: [] },
    });
    renderDetail('member');
    expect(screen.queryByRole('button', { name: 'Add panel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('opens the add-panel dialog and PATCHes the layout on submit', async () => {
    loadPanelDataFn.mockResolvedValue({
      ok: true,
      data: { totalCount: 4, buckets: [], recentLogs: [] },
    });
    updateDashboardFn.mockResolvedValue({ ok: true, data: dashboard() });
    const onChanged = vi.fn();
    const u = userEvent.setup();

    render(
      <NuqsTestingAdapter>
        <SessionProvider session={sessionForRole('tenant_admin')}>
          <DashboardDetail
            dashboard={dashboard()}
            savedQueries={savedQueries}
            onChanged={onChanged}
          />
        </SessionProvider>
      </NuqsTestingAdapter>,
    );
    await waitFor(() => expect(loadPanelDataFn).toHaveBeenCalledTimes(1));

    await u.click(screen.getByRole('button', { name: 'Add panel' }));
    await u.type(screen.getByLabelText('Title'), 'New panel');
    const addPanelButtons = screen.getAllByRole('button', { name: 'Add panel' });
    await u.click(addPanelButtons[addPanelButtons.length - 1] as HTMLElement);

    await waitFor(() => expect(updateDashboardFn).toHaveBeenCalledTimes(1));
    const call = updateDashboardFn.mock.calls[0]?.[0] as {
      data: { patch: { layout: { panels: unknown[] } } };
    };
    expect(call.data.patch.layout.panels).toHaveLength(2);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('removing a panel filters it out of the layout PATCH', async () => {
    loadPanelDataFn.mockResolvedValue({
      ok: true,
      data: { totalCount: 4, buckets: [], recentLogs: [] },
    });
    updateDashboardFn.mockResolvedValue({ ok: true, data: dashboard() });
    const u = userEvent.setup();

    renderDetail();
    await waitFor(() => expect(loadPanelDataFn).toHaveBeenCalledTimes(1));

    await u.click(screen.getByRole('button', { name: 'Remove' }));
    await u.click(screen.getByRole('button', { name: 'Remove panel' }));

    await waitFor(() => expect(updateDashboardFn).toHaveBeenCalledTimes(1));
    const call = updateDashboardFn.mock.calls[0]?.[0] as {
      data: { patch: { layout: { panels: unknown[] } } };
    };
    expect(call.data.patch.layout.panels).toHaveLength(0);
  });
});
