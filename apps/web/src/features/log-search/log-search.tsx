import * as React from 'react';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { LogList } from '../log-explorer/log-list';
import type { TailItem } from '../log-explorer/use-log-tail';
import { SearchBar } from './search-bar';
import { type SearchExecutor, type SearchFilters, searchFiltersActive } from './search-query';
import { useLogSearch } from './use-log-search';

// The historical-search surface. It composes the SearchBar (filter builder) with a
// keyset-paginated result list rendered through the SAME LogList/LogRow the live
// tail uses — the "shared explorer surface" the issue asks for. Filter STATE is
// owned by the route (wired to nuqs URL state, so a search is shareable) and passed
// in; the `search` executor is injected (the BFF server fn in production, a mock in
// tests) so this component has no direct query-service dependency.

export interface LogSearchProps {
  filters: SearchFilters;
  onFiltersChange: (next: SearchFilters) => void;
  /** Executes a page of search (the BFF server fn; a mock in tests). */
  search: SearchExecutor;
  /**
   * Run the incoming (URL) filters once on mount so a shared link reproduces its
   * results without a manual click. Defaults to true.
   */
  runOnMount?: boolean;
}

export function LogSearch({ filters, onFiltersChange, search, runOnMount = true }: LogSearchProps) {
  const { status, events, nextCursor, error, hasSearched, run, loadMore } = useLogSearch({
    search,
  });

  // Auto-run ONCE on mount with whatever filters arrived in the URL. A ref holds the
  // latest filters so this neither captures a stale value nor re-fires on every edit
  // (search executes on explicit submit, never on keystroke — no request spam).
  const filtersRef = React.useRef(filters);
  filtersRef.current = filters;
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only run.
  React.useEffect(() => {
    if (runOnMount) run(filtersRef.current);
  }, []);

  const items = React.useMemo<TailItem[]>(
    () => events.map((event, seq) => ({ kind: 'log', seq, event })),
    [events],
  );

  const busy = status === 'loading' || status === 'loadingMore';

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-card border border-border-default bg-bg-base">
      <SearchBar
        value={filters}
        onChange={onFiltersChange}
        onSearch={() => run(filters)}
        disabled={status === 'loading'}
      />

      {/* <section> with an accessible name is an implicit role="region". */}
      <section
        aria-label="Search results"
        aria-busy={busy}
        className="min-h-0 flex-1 overflow-auto"
      >
        {status === 'loading' ? (
          <LoadingState label="Searching…" />
        ) : status === 'error' ? (
          // First-page failure (validation 400 or unavailable). The message is
          // user-safe (validation text or a generic notice); retry re-runs.
          <div className="p-6">
            <ErrorState title="Search failed" message={error} onRetry={() => run(filters)} />
          </div>
        ) : events.length > 0 ? (
          <>
            <LogList items={items} />
            <Footer
              count={events.length}
              hasMore={nextCursor !== undefined}
              loadingMore={status === 'loadingMore'}
              error={error}
              onLoadMore={loadMore}
            />
          </>
        ) : hasSearched ? (
          <div className="p-6">
            <EmptyState
              title="No matching logs"
              description={
                searchFiltersActive(filters)
                  ? 'No logs match these filters in the selected range. Adjust or clear them.'
                  : 'No logs found for your tenant yet.'
              }
            />
          </div>
        ) : (
          <div className="p-6">
            <EmptyState
              title="Search your logs"
              description="Enter a query and press Search to look through your tenant's history."
            />
          </div>
        )}
      </section>
    </div>
  );
}

function Footer({
  count,
  hasMore,
  loadingMore,
  error,
  onLoadMore,
}: {
  count: number;
  hasMore: boolean;
  loadingMore: boolean;
  error?: string;
  onLoadMore: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 border-border-subtle border-t p-3">
      {/* A load-more failure keeps the loaded pages and surfaces here. */}
      {error ? (
        <p role="alert" className="text-severity-error-fg text-sm">
          {error}
        </p>
      ) : null}
      {hasMore ? (
        <Button variant="secondary" size="sm" disabled={loadingMore} onClick={onLoadMore}>
          {loadingMore ? <Spinner className="size-4" label="Loading more results" /> : 'Load more'}
        </Button>
      ) : (
        <p className="text-fg-subtle text-xs">
          {count} result{count === 1 ? '' : 's'} — end of results
        </p>
      )}
    </div>
  );
}
