import * as React from 'react';
import { EmptyState } from '../../components/states';
import { FilterBar } from './filter-bar';
import { filtersActive, type LogFilters, matchesFilters } from './filtering';
import { LogList } from './log-list';
import { isNearBottom, nextAutoscroll } from './scroll';
import { TailToolbar } from './tail-toolbar';
import { type EventSourceFactory, type TailItem, useLogTail } from './use-log-tail';

// The live-tail explorer surface: filter bar + stream toolbar + a bounded, dense,
// autoscrolling log view. Filter STATE is owned by the caller (the route wires it to
// nuqs URL state) and passed in — keeping URL/router concerns out of this component
// so it stays testable and reusable. #22 (historical search) composes the same
// FilterBar + LogList over its own data source; this file is the live-tail wiring.

export interface LogExplorerProps {
  filters: LogFilters;
  onFiltersChange: (next: LogFilters) => void;
  /**
   * Fired when the live tail exhausts its bounded reconnect attempts (terminal
   * `offline`). The route wires this to probe the session and redirect to /login if
   * it is gone (the dead-session path); a still-valid session is a transport outage,
   * recoverable via the toolbar's Reconnect button.
   */
  onReconnectExhausted?: () => void;
  /** Test seam: inject a mock EventSource (jsdom has none). */
  createEventSource?: EventSourceFactory;
  /** Override the BFF endpoint (defaults to /api/tail). */
  tailUrl?: string;
}

export function LogExplorer({
  filters,
  onFiltersChange,
  onReconnectExhausted,
  createEventSource,
  tailUrl,
}: LogExplorerProps) {
  const tail = useLogTail({ createEventSource, url: tailUrl, onReconnectExhausted });
  const [autoscroll, setAutoscroll] = React.useState(true);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const autoscrollRef = React.useRef(autoscroll);
  autoscrollRef.current = autoscroll;

  // Gap markers always show (they describe the stream itself); log lines pass the
  // client-side filter predicate.
  const filtered = React.useMemo<TailItem[]>(
    () => tail.items.filter((it) => it.kind === 'gap' || matchesFilters(it.event, filters)),
    [tail.items, filters],
  );

  // Stick to the newest row while autoscroll is on. `filtered` is a TRIGGER dep:
  // the effect re-runs whenever the rendered rows change so the view re-pins to the
  // bottom, even though it doesn't read `filtered` directly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin on new rows.
  React.useEffect(() => {
    if (!autoscroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filtered, autoscroll]);

  const onScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Two-way: scroll up to detach (stop yanking to the bottom), scroll back to the
    // bottom to re-arm (M1). The decision is a pure, unit-tested predicate.
    const atBottom = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    setAutoscroll((current) => nextAutoscroll(current, atBottom));
  }, []);

  const logCount = filtered.filter((i) => i.kind === 'log').length;
  const hasMatches = logCount > 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-card border border-border-default bg-bg-base">
      <FilterBar value={filters} onChange={onFiltersChange} />
      <TailToolbar
        status={tail.status}
        paused={tail.paused}
        onPause={tail.pause}
        onResume={tail.resume}
        onReconnect={tail.reconnect}
        autoscroll={autoscroll}
        onToggleAutoscroll={() => setAutoscroll((v) => !v)}
        onClear={tail.clear}
        visibleCount={logCount}
        bufferedCount={tail.items.filter((i) => i.kind === 'log').length}
        droppedCount={tail.droppedCount}
        reconnectCount={tail.reconnectCount}
      />

      {/* role="log" marks this as a streaming log region; aria-live=polite lets AT
          announce new lines without us hand-rolling a live region. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-label="Live log stream"
        className="min-h-0 flex-1 overflow-auto"
      >
        {hasMatches || filtered.some((i) => i.kind === 'gap') ? (
          <LogList items={filtered} />
        ) : (
          <div className="p-6">
            {tail.items.length === 0 ? (
              <EmptyState
                title="Waiting for logs"
                description="New logs for your tenant will stream in here as they arrive."
              />
            ) : filtersActive(filters) ? (
              <EmptyState
                title="No matching logs"
                description="No buffered logs match the current filters. Adjust or clear them."
              />
            ) : (
              <EmptyState title="No logs yet" description="The stream is connected and waiting." />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
