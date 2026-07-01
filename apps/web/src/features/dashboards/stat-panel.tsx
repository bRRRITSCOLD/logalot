import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { cn } from '../../lib/cn';
import type { PanelVizState } from './timeseries-chart';

export interface StatPanelProps {
  /** The panel's total match count (`PanelDataResult.totalCount`). */
  value: number;
  state?: PanelVizState;
  /** Shown in the error state; falls back to `ErrorState`'s generic copy. */
  errorMessage?: string;
  className?: string;
}

/**
 * Large formatted count for a `stat` panel. Purely presentational, sharing
 * `TimeseriesChart`'s `default | loading | empty | error` state set. `0` is a
 * valid count (not implicitly "empty") — the caller decides `empty` explicitly.
 */
export function StatPanel({ value, state = 'default', errorMessage, className }: StatPanelProps) {
  if (state === 'loading') {
    return <LoadingState className={className} label="Loading stat…" />;
  }
  if (state === 'error') {
    return <ErrorState className={className} message={errorMessage} />;
  }
  if (state === 'empty') {
    return (
      <EmptyState
        className={className}
        title="No data"
        description="No matching events in this range."
      />
    );
  }

  return (
    <p className={cn('font-semibold text-4xl text-fg-default tabular-nums', className)}>
      {new Intl.NumberFormat('en-US').format(value)}
    </p>
  );
}
