import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelDataOutcome } from './panel-data';

const loadPanelDataFn = vi.fn<(...args: unknown[]) => Promise<PanelDataOutcome>>();
vi.mock('../../server/panel-data', () => ({
  loadPanelDataFn: (...args: unknown[]) => loadPanelDataFn(...args),
}));

// Imported after the mock is registered.
import { usePanelData } from './use-panel-data';

const range = { from: '2026-06-27T10:00:00.000Z', to: '2026-06-27T11:00:00.000Z' };

afterEach(() => {
  loadPanelDataFn.mockReset();
});

describe('usePanelData', () => {
  it('starts loading, then maps a successful outcome to a gap-filled series + count', async () => {
    loadPanelDataFn.mockResolvedValue({
      ok: true,
      data: {
        totalCount: 5,
        buckets: [{ bucketStart: '2026-06-27T10:30:00.000Z', count: 5 }],
        recentLogs: [],
      },
    });

    const { result } = renderHook(() => usePanelData('sq-1', range, 2));
    expect(result.current.state).toBe('loading');

    await waitFor(() => expect(result.current.state).toBe('default'));
    expect(result.current.totalCount).toBe(5);
    expect(result.current.series).toHaveLength(2);
    expect(result.current.series.reduce((sum, b) => sum + b.count, 0)).toBe(5);
    expect(result.current.errorMessage).toBeNull();
  });

  it('maps a failed outcome to the error state with the given message', async () => {
    loadPanelDataFn.mockResolvedValue({ ok: false, message: 'panel query not found' });

    const { result } = renderHook(() => usePanelData('sq-1', range));

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorMessage).toBe('panel query not found');
    expect(result.current.series).toEqual([]);
  });

  it('refetches when the range changes, calling loadPanelDataFn with the new range', async () => {
    loadPanelDataFn.mockResolvedValue({
      ok: true,
      data: { totalCount: 1, buckets: [], recentLogs: [] },
    });

    const { rerender } = renderHook(({ r }) => usePanelData('sq-1', r), {
      initialProps: { r: range },
    });
    await waitFor(() => expect(loadPanelDataFn).toHaveBeenCalledTimes(1));

    const nextRange = { from: '2026-06-28T10:00:00.000Z', to: '2026-06-28T11:00:00.000Z' };
    rerender({ r: nextRange });

    await waitFor(() => expect(loadPanelDataFn).toHaveBeenCalledTimes(2));
    const lastCall = loadPanelDataFn.mock.calls[1]?.[0] as { data: { from: string; to: string } };
    expect(lastCall.data.from).toBe(nextRange.from);
    expect(lastCall.data.to).toBe(nextRange.to);
  });
});
