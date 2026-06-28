import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LogSearch } from './log-search';
import {
  EMPTY_SEARCH_FILTERS,
  MAX_SEARCH_RESULTS,
  type SearchFilters,
  type SearchOutcome,
} from './search-query';

function event(message: string, overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 't-1',
    ts: '2026-06-27T10:00:00Z',
    service: 'api',
    level: 'info',
    message,
    labels: {},
    ...overrides,
  } as const;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Controlled wrapper mirroring how the route wires nuqs filter state. */
function Harness({
  search,
  initial = EMPTY_SEARCH_FILTERS,
}: {
  search: (f: SearchFilters, cursor?: string) => Promise<SearchOutcome>;
  initial?: SearchFilters;
}) {
  const [filters, setFilters] = React.useState<SearchFilters>(initial);
  return (
    <div style={{ height: 600 }}>
      <LogSearch filters={filters} onFiltersChange={setFilters} search={search} />
    </div>
  );
}

describe('LogSearch (integration, mocked query API)', () => {
  it('auto-runs the URL filters on mount and renders result rows (shareable search)', async () => {
    const search = vi.fn<(f: SearchFilters, cursor?: string) => Promise<SearchOutcome>>(
      async (): Promise<SearchOutcome> => ({ ok: true, events: [event('boot result')] }),
    );
    render(<Harness search={search} initial={{ ...EMPTY_SEARCH_FILTERS, text: 'boot' }} />);

    expect(await screen.findByText('boot result')).toBeInTheDocument();
    // mount auto-ran with the incoming filters (shared-link reproducibility)
    expect(search.mock.calls[0]?.[0]).toEqual({ ...EMPTY_SEARCH_FILTERS, text: 'boot' });
  });

  it('shows the idle prompt and does NOT query when the URL has no filters', async () => {
    const search = vi.fn(async (): Promise<SearchOutcome> => ({ ok: true, events: [] }));
    render(<Harness search={search} />);
    expect(await screen.findByText(/search your logs/i)).toBeInTheDocument();
    // a bare entry (or tail→search toggle with no filters) must not fire a request
    expect(search).not.toHaveBeenCalled();
  });

  it('shows a loading state while the first page is in flight', async () => {
    const d = deferred<SearchOutcome>();
    const search = vi.fn(() => d.promise);
    render(<Harness search={search} initial={{ ...EMPTY_SEARCH_FILTERS, text: 'q' }} />);
    expect(await screen.findByText(/searching/i)).toBeInTheDocument();
    d.resolve({ ok: true, events: [event('done')] });
    expect(await screen.findByText('done')).toBeInTheDocument();
  });

  it('runs a new search from the bar and shows results', async () => {
    const search = vi
      .fn<(f: SearchFilters, cursor?: string) => Promise<SearchOutcome>>()
      .mockResolvedValue({ ok: true, events: [event('typed result')] });
    const u = userEvent.setup();
    render(<Harness search={search} />);
    // gated: no auto-run on an empty URL, so the idle prompt shows first
    await screen.findByText(/search your logs/i);
    expect(search).not.toHaveBeenCalled();

    await u.type(screen.getByLabelText(/full-text search/i), 'typed');
    await u.click(screen.getByRole('button', { name: /^search$/i }));
    expect(await screen.findByText('typed result')).toBeInTheDocument();
  });

  it('pages results with Load more via the keyset cursor, hiding it on the final page', async () => {
    const search = vi
      .fn<(f: SearchFilters, cursor?: string) => Promise<SearchOutcome>>()
      .mockResolvedValueOnce({ ok: true, events: [event('page one')], nextCursor: 'CUR_2' })
      .mockResolvedValueOnce({ ok: true, events: [event('page two')] });
    const u = userEvent.setup();
    render(<Harness search={search} initial={{ ...EMPTY_SEARCH_FILTERS, text: 'q' }} />);
    expect(await screen.findByText('page one')).toBeInTheDocument();

    const loadMore = screen.getByRole('button', { name: /load more/i });
    await u.click(loadMore);

    expect(await screen.findByText('page two')).toBeInTheDocument();
    expect(screen.getByText('page one')).toBeInTheDocument(); // appended, not replaced
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
    expect(search.mock.calls[1]?.[1]).toBe('CUR_2');
  });

  it('renders an empty state when a search returns no results', async () => {
    const search = vi.fn(async (): Promise<SearchOutcome> => ({ ok: true, events: [] }));
    render(<Harness search={search} initial={{ ...EMPTY_SEARCH_FILTERS, text: 'zzz' }} />);
    expect(await screen.findByText(/no matching logs/i)).toBeInTheDocument();
  });

  it('renders a validation error from the server and retries', async () => {
    const search = vi
      .fn<(f: SearchFilters, cursor?: string) => Promise<SearchOutcome>>()
      .mockResolvedValueOnce({ ok: false, message: "'from' must be before 'to'" })
      .mockResolvedValueOnce({ ok: true, events: [event('after retry')] });
    const u = userEvent.setup();
    render(<Harness search={search} initial={{ ...EMPTY_SEARCH_FILTERS, text: 'q' }} />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/'from' must be before 'to'/)).toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('after retry')).toBeInTheDocument();
  });

  it('reuses the shared log-row (severity badge) to render a result', async () => {
    const search = vi.fn(
      async (): Promise<SearchOutcome> => ({
        ok: true,
        events: [event('boom', { level: 'fatal' })],
      }),
    );
    render(<Harness search={search} initial={{ ...EMPTY_SEARCH_FILTERS, text: 'q' }} />);
    const region = await screen.findByRole('region', { name: /search results/i });
    expect(await within(region).findByText('boom')).toBeInTheDocument();
    expect(within(region).getByText('fatal')).toBeInTheDocument();
  });

  it('stops paging with a refine notice once the result ceiling is reached', async () => {
    const fullPage = Array.from({ length: MAX_SEARCH_RESULTS }, (_, i) => event(`row ${i}`));
    const search = vi.fn(
      async (): Promise<SearchOutcome> => ({ ok: true, events: fullPage, nextCursor: 'MORE' }),
    );
    render(<Harness search={search} initial={{ ...EMPTY_SEARCH_FILTERS, text: 'q' }} />);

    expect(await screen.findByText(/refine your filters/i)).toBeInTheDocument();
    // ceiling reached → no Load more even though upstream offered a nextCursor
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });
});
