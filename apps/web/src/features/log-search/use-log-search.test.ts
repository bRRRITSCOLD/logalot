import type { LogLevel } from '@logalot/contracts';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TailLogEvent } from '../log-explorer/tail-event';
import { EMPTY_SEARCH_FILTERS, type SearchFilters, type SearchOutcome } from './search-query';
import { useLogSearch } from './use-log-search';

function event(message: string, level: LogLevel = 'info'): TailLogEvent {
  return {
    tenant_id: 't-1',
    ts: '2026-06-27T10:00:00Z',
    service: 'api',
    level,
    message,
    labels: {},
  };
}

/** A deferred promise so a test can control exactly when an executor resolves. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useLogSearch', () => {
  it('runs the first page: loading → success with events and nextCursor', async () => {
    const search = vi.fn(
      async (): Promise<SearchOutcome> => ({
        ok: true,
        events: [event('first')],
        nextCursor: 'NEXT==',
      }),
    );
    const { result } = renderHook(() => useLogSearch({ search }));

    act(() => result.current.run(EMPTY_SEARCH_FILTERS));
    expect(result.current.status).toBe('loading');

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.events.map((e) => e.message)).toEqual(['first']);
    expect(result.current.nextCursor).toBe('NEXT==');
    expect(result.current.hasSearched).toBe(true);
  });

  it('appends the next page via the keyset cursor on loadMore, then drops the cursor on the final page', async () => {
    const search = vi
      .fn<(f: SearchFilters, cursor?: string) => Promise<SearchOutcome>>()
      .mockResolvedValueOnce({ ok: true, events: [event('p1')], nextCursor: 'CUR_2' })
      .mockResolvedValueOnce({ ok: true, events: [event('p2')] }); // final page, no cursor

    const { result } = renderHook(() => useLogSearch({ search }));

    act(() => result.current.run({ ...EMPTY_SEARCH_FILTERS, text: 'q' }));
    await waitFor(() => expect(result.current.status).toBe('success'));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    // second call reuses the original filters and passes the prior nextCursor
    expect(search.mock.calls[1]?.[0]).toEqual({ ...EMPTY_SEARCH_FILTERS, text: 'q' });
    expect(search.mock.calls[1]?.[1]).toBe('CUR_2');
    expect(result.current.events.map((e) => e.message)).toEqual(['p1', 'p2']);
    expect(result.current.nextCursor).toBeUndefined();
  });

  it('does nothing on loadMore when there is no nextCursor', async () => {
    const search = vi.fn(
      async (): Promise<SearchOutcome> => ({ ok: true, events: [event('only')] }),
    );
    const { result } = renderHook(() => useLogSearch({ search }));
    act(() => result.current.run(EMPTY_SEARCH_FILTERS));
    await waitFor(() => expect(result.current.status).toBe('success'));

    act(() => result.current.loadMore());
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('reports an empty result as a successful, empty search', async () => {
    const search = vi.fn(async (): Promise<SearchOutcome> => ({ ok: true, events: [] }));
    const { result } = renderHook(() => useLogSearch({ search }));
    act(() => result.current.run(EMPTY_SEARCH_FILTERS));
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.events).toEqual([]);
    expect(result.current.hasSearched).toBe(true);
  });

  it('surfaces a failed search as an error with the message', async () => {
    const search = vi.fn(
      async (): Promise<SearchOutcome> => ({ ok: false, message: "'from' must be before 'to'" }),
    );
    const { result } = renderHook(() => useLogSearch({ search }));
    act(() => result.current.run(EMPTY_SEARCH_FILTERS));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe("'from' must be before 'to'");
    expect(result.current.events).toEqual([]);
  });

  it('keeps existing pages when a loadMore fails', async () => {
    const search = vi
      .fn<(f: SearchFilters, cursor?: string) => Promise<SearchOutcome>>()
      .mockResolvedValueOnce({ ok: true, events: [event('p1')], nextCursor: 'CUR_2' })
      .mockResolvedValueOnce({ ok: false, message: 'boom' });
    const { result } = renderHook(() => useLogSearch({ search }));
    act(() => result.current.run(EMPTY_SEARCH_FILTERS));
    await waitFor(() => expect(result.current.status).toBe('success'));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.events).toHaveLength(1); // prior page preserved
    expect(result.current.nextCursor).toBe('CUR_2'); // still offer retry
  });

  it('ignores a stale in-flight response when a newer run supersedes it', async () => {
    const first = deferred<SearchOutcome>();
    const second = deferred<SearchOutcome>();
    const search = vi
      .fn<(f: SearchFilters, cursor?: string) => Promise<SearchOutcome>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useLogSearch({ search }));
    act(() => result.current.run({ ...EMPTY_SEARCH_FILTERS, text: 'a' }));
    act(() => result.current.run({ ...EMPTY_SEARCH_FILTERS, text: 'b' }));

    // resolve the SECOND (current) run first, then the stale first run.
    await act(async () => {
      second.resolve({ ok: true, events: [event('b-result')] });
      first.resolve({ ok: true, events: [event('a-result')] });
    });

    expect(result.current.events.map((e) => e.message)).toEqual(['b-result']);
  });
});
