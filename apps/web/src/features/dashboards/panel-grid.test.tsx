import type { Panel, SavedQueryResponse } from '@logalot/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelDataOutcome } from './panel-data';

const loadPanelDataFn = vi.fn<(...args: unknown[]) => Promise<PanelDataOutcome>>();
vi.mock('../../server/panel-data', () => ({
  loadPanelDataFn: (...args: unknown[]) => loadPanelDataFn(...args),
}));

// Imported after the mock is registered.
import { PanelGrid } from './panel-grid';

const range = { from: '2026-06-27T10:00:00.000Z', to: '2026-06-27T11:00:00.000Z' };

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: 'p1',
    type: 'timeseries',
    title: '5xx rate',
    savedQueryId: '00000000-0000-0000-0000-0000000000f1',
    viz: {},
    grid: { x: 0, y: 0, w: 4, h: 2 },
    ...overrides,
  };
}

function savedQuery(overrides: Partial<SavedQueryResponse> = {}): SavedQueryResponse {
  return {
    id: '00000000-0000-0000-0000-0000000000f1',
    tenantId: '00000000-0000-0000-0000-0000000000aa',
    name: '5xx errors',
    description: null,
    queryText: '',
    filters: {},
    timeRange: {},
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

afterEach(() => {
  loadPanelDataFn.mockReset();
});

describe('PanelGrid', () => {
  it('renders a timeseries panel and a stat panel, each with its saved-query subtitle', async () => {
    loadPanelDataFn.mockResolvedValue({
      ok: true,
      data: {
        totalCount: 7,
        buckets: [{ bucketStart: '2026-06-27T10:30:00.000Z', count: 7 }],
        recentLogs: [],
      },
    });

    const panels: Panel[] = [
      panel({ id: 'p1', type: 'timeseries', title: '5xx rate' }),
      panel({
        id: 'p2',
        type: 'stat',
        title: 'Total errors',
        savedQueryId: '00000000-0000-0000-0000-0000000000f2',
      }),
    ];
    const savedQueries = [
      savedQuery({ id: '00000000-0000-0000-0000-0000000000f1', name: '5xx errors' }),
      savedQuery({ id: '00000000-0000-0000-0000-0000000000f2', name: 'All errors' }),
    ];

    render(<PanelGrid panels={panels} savedQueries={savedQueries} range={range} />);

    expect(screen.getByText('5xx rate')).toBeInTheDocument();
    expect(screen.getByText('Total errors')).toBeInTheDocument();
    expect(screen.getByText('5xx errors')).toBeInTheDocument();
    expect(screen.getByText('All errors')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('7')).toBeInTheDocument());
    expect(screen.getByRole('img', { name: /event count over time/i })).toBeInTheDocument();
  });

  it('degrades only the panel whose fetch fails', async () => {
    loadPanelDataFn.mockImplementation(async (arg: unknown) => {
      const { data } = arg as { data: { savedQueryId: string } };
      if (data.savedQueryId === '00000000-0000-0000-0000-0000000000f2') {
        return { ok: false, message: 'panel query not found' };
      }
      return {
        ok: true,
        data: { totalCount: 3, buckets: [], recentLogs: [] },
      };
    });

    const panels: Panel[] = [
      panel({ id: 'p1', type: 'stat', title: 'Good panel' }),
      panel({
        id: 'p2',
        type: 'stat',
        title: 'Broken panel',
        savedQueryId: '00000000-0000-0000-0000-0000000000f2',
      }),
    ];
    render(<PanelGrid panels={panels} savedQueries={[]} range={range} />);

    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
    expect(screen.getByText('panel query not found')).toBeInTheDocument();
    // the good panel's value is unaffected by its sibling's failure
    expect(screen.getByText('Good panel')).toBeInTheDocument();
    expect(screen.getByText('Broken panel')).toBeInTheDocument();
  });
});
