import * as React from 'react';
import type { TailLogEvent } from '../log-explorer/tail-event';
import type { SearchExecutor, SearchFilters } from './search-query';

// ── useLogSearch: the historical-search state machine ───────────────────────
//
// The REST counterpart of useLogTail. Where the tail owns a streaming buffer, this
// owns a keyset-paginated RESULT SET: a first page from `run(filters)` and further
// pages appended via `loadMore()` using the previous page's opaque `nextCursor`
// (passed back verbatim — query-service owns its meaning). The actual fetch is an
// injected `SearchExecutor` (the BFF server fn in production, a mock in tests), so
// the page/append/error logic is testable without a live query-service.
//
// Concurrency: every request carries a monotonic id; a response is applied only if
// it is still the latest (`reqId.current`). So a fast re-search supersedes an
// in-flight one without a torn result, and a stale page can never overwrite newer
// state. `loadMore` reuses the filters captured by the last `run` (stored in a ref),
// so paging stays consistent even if the filter inputs have since changed.

export type SearchStatus = 'idle' | 'loading' | 'success' | 'loadingMore' | 'error';

export interface UseLogSearchOptions {
  /** Executes one page; injected so the hook has no direct BFF dependency. */
  search: SearchExecutor;
}

export interface UseLogSearch {
  status: SearchStatus;
  /** Accumulated results across loaded pages, in server order. */
  events: TailLogEvent[];
  /** Opaque cursor for the next page; absent on the final page. */
  nextCursor?: string;
  /** User-safe error message for a failed (first or subsequent) page. */
  error?: string;
  /** True once a search has completed at least once (drives empty-state copy). */
  hasSearched: boolean;
  /** Run a fresh search (resets results to page one). */
  run: (filters: SearchFilters) => void;
  /** Append the next page; a no-op when there is no `nextCursor` or a load is in flight. */
  loadMore: () => void;
}

interface State {
  status: SearchStatus;
  events: TailLogEvent[];
  nextCursor?: string;
  error?: string;
  hasSearched: boolean;
}

const INITIAL: State = { status: 'idle', events: [], hasSearched: false };

export function useLogSearch({ search }: UseLogSearchOptions): UseLogSearch {
  const [state, setState] = React.useState<State>(INITIAL);

  // Latest-request id: a response is honored only while it matches.
  const reqId = React.useRef(0);
  // Filters of the in-flight/last search, so loadMore pages the SAME query.
  const lastFilters = React.useRef<SearchFilters | null>(null);
  // Latest known cursor, read synchronously by loadMore (avoids a stale closure).
  const cursorRef = React.useRef<string | undefined>(undefined);
  const inFlight = React.useRef(false);

  const run = React.useCallback(
    (filters: SearchFilters) => {
      const id = ++reqId.current;
      lastFilters.current = filters;
      cursorRef.current = undefined;
      inFlight.current = true;
      setState({ status: 'loading', events: [], hasSearched: false });

      void search(filters).then((out) => {
        if (id !== reqId.current) return; // superseded by a newer run
        inFlight.current = false;
        if (out.ok) {
          cursorRef.current = out.nextCursor;
          setState({
            status: 'success',
            events: out.events,
            nextCursor: out.nextCursor,
            hasSearched: true,
          });
        } else {
          cursorRef.current = undefined;
          setState({ status: 'error', events: [], error: out.message, hasSearched: true });
        }
      });
    },
    [search],
  );

  const loadMore = React.useCallback(() => {
    const filters = lastFilters.current;
    const cursor = cursorRef.current;
    if (!filters || !cursor || inFlight.current) return;

    const id = ++reqId.current;
    inFlight.current = true;
    setState((s) => ({ ...s, status: 'loadingMore', error: undefined }));

    void search(filters, cursor).then((out) => {
      if (id !== reqId.current) return;
      inFlight.current = false;
      if (out.ok) {
        cursorRef.current = out.nextCursor;
        setState((s) => ({
          status: 'success',
          events: [...s.events, ...out.events],
          nextCursor: out.nextCursor,
          hasSearched: true,
        }));
      } else {
        // Keep the pages already loaded; surface the error and leave the cursor so
        // the user can retry the same "Load more".
        setState((s) => ({ ...s, status: 'success', error: out.message }));
      }
    });
  }, [search]);

  return {
    status: state.status,
    events: state.events,
    nextCursor: state.nextCursor,
    error: state.error,
    hasSearched: state.hasSearched,
    run,
    loadMore,
  };
}
