import type { DashboardResponse, Panel, SavedQueryResponse } from '@logalot/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardOutcome } from '../../server/dashboards';

const updateDashboardFn =
  vi.fn<(...args: unknown[]) => Promise<DashboardOutcome<DashboardResponse>>>();
vi.mock('../../server/dashboards', () => ({
  updateDashboardFn: (...args: unknown[]) => updateDashboardFn(...args),
}));

// Imported after the mock is registered.
import { PanelDialog } from './panel-dialog';

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

function dashboard(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    id: '00000000-0000-0000-0000-0000000000d1',
    tenantId: '00000000-0000-0000-0000-0000000000aa',
    name: 'Errors overview',
    description: null,
    layout: { panels: [panel()] },
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const savedQueries: SavedQueryResponse[] = [
  {
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
  },
  {
    id: '00000000-0000-0000-0000-0000000000f2',
    tenantId: '00000000-0000-0000-0000-0000000000aa',
    name: 'All errors',
    description: null,
    queryText: '',
    filters: {},
    timeRange: {},
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

afterEach(() => {
  updateDashboardFn.mockReset();
});

describe('PanelDialog', () => {
  it('add mode: appends the new panel and PATCHes the whole layout', async () => {
    updateDashboardFn.mockResolvedValue({ ok: true, data: dashboard() });
    const onSaved = vi.fn();
    const u = userEvent.setup();

    render(
      <PanelDialog
        dashboard={dashboard()}
        savedQueries={savedQueries}
        editing={null}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    await u.type(screen.getByLabelText('Title'), 'New panel');
    await u.selectOptions(screen.getByLabelText('Saved query'), 'All errors');
    await u.click(screen.getByRole('button', { name: 'Add panel' }));

    await waitFor(() => expect(updateDashboardFn).toHaveBeenCalledTimes(1));
    const call = updateDashboardFn.mock.calls[0]?.[0] as {
      data: { id: string; patch: { layout: { panels: Panel[] } } };
    };
    expect(call.data.id).toBe(dashboard().id);
    expect(call.data.patch.layout.panels).toHaveLength(2);
    const added = call.data.patch.layout.panels[1];
    expect(added?.title).toBe('New panel');
    expect(added?.savedQueryId).toBe('00000000-0000-0000-0000-0000000000f2');
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('edit mode: replaces the panel with the matching id', async () => {
    updateDashboardFn.mockResolvedValue({ ok: true, data: dashboard() });
    const u = userEvent.setup();

    render(
      <PanelDialog
        dashboard={dashboard()}
        savedQueries={savedQueries}
        editing={panel()}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const title = screen.getByLabelText('Title');
    await u.clear(title);
    await u.type(title, 'Renamed panel');
    await u.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateDashboardFn).toHaveBeenCalledTimes(1));
    const call = updateDashboardFn.mock.calls[0]?.[0] as {
      data: { patch: { layout: { panels: Panel[] } } };
    };
    expect(call.data.patch.layout.panels).toHaveLength(1);
    expect(call.data.patch.layout.panels[0]).toMatchObject({ id: 'p1', title: 'Renamed panel' });
  });

  it('renders the saved-query picker with each query name as an option', () => {
    render(
      <PanelDialog
        dashboard={dashboard()}
        savedQueries={savedQueries}
        editing={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const picker = screen.getByLabelText('Saved query') as HTMLSelectElement;
    const optionLabels = Array.from(picker.options).map((o) => o.textContent);
    expect(optionLabels).toEqual(['5xx errors', 'All errors']);
  });

  it('the type toggle switches the selected panel type', async () => {
    updateDashboardFn.mockResolvedValue({ ok: true, data: dashboard() });
    const u = userEvent.setup();

    render(
      <PanelDialog
        dashboard={dashboard()}
        savedQueries={savedQueries}
        editing={panel({ type: 'timeseries' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await u.selectOptions(screen.getByLabelText('Type'), 'Stat');
    await u.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateDashboardFn).toHaveBeenCalledTimes(1));
    const call = updateDashboardFn.mock.calls[0]?.[0] as {
      data: { patch: { layout: { panels: Panel[] } } };
    };
    expect(call.data.patch.layout.panels[0]?.type).toBe('stat');
  });

  it('surfaces the server error and does not call onSaved', async () => {
    updateDashboardFn.mockResolvedValue({
      ok: false,
      error: { kind: 'forbidden', message: 'You do not have permission to do that.' },
    });
    const onSaved = vi.fn();
    const u = userEvent.setup();

    render(
      <PanelDialog
        dashboard={dashboard()}
        savedQueries={savedQueries}
        editing={null}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    await u.type(screen.getByLabelText('Title'), 'New panel');
    await u.click(screen.getByRole('button', { name: 'Add panel' }));

    expect(await screen.findByText('You do not have permission to do that.')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
