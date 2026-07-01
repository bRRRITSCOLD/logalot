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
});
