import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { cn } from '../../lib/cn';
import type { PanelBucket } from './panel-data';

/** Shared viz-primitive state set: purely-presentational, driven by the caller. */
export type PanelVizState = 'default' | 'loading' | 'empty' | 'error';

export interface TimeseriesChartProps {
  /** A dense (gap-filled), time-monotonic bucket series — see `gapFillBuckets`. */
  series: PanelBucket[];
  state?: PanelVizState;
  /** Shown in the error state; falls back to `ErrorState`'s generic copy. */
  errorMessage?: string;
  /** A bucket's bar turns `severity-warn` once its count reaches this value. */
  warnThreshold?: number;
  /** A bucket's bar turns `severity-error` once its count reaches this value (checked before warn). */
  errorThreshold?: number;
  className?: string;
}

const VIEWBOX_HEIGHT = 100;
const BAR_GAP = 2;

/** Bar fill token: severity-error/warn once a count crosses its threshold, brand otherwise. */
function barFill(count: number, warnThreshold?: number, errorThreshold?: number): string {
  if (errorThreshold !== undefined && count >= errorThreshold) {
    return 'var(--color-severity-error-fg)';
  }
  if (warnThreshold !== undefined && count >= warnThreshold) {
    return 'var(--color-severity-warn-fg)';
  }
  return 'var(--color-brand-solid)';
}

/**
 * Inline SVG bar chart over a gap-filled panel bucket series. Purely
 * presentational — the `default | loading | empty | error` set covers every
 * state the panel-fetching caller (T8) can hand it. An empty series renders
 * the empty state even when the caller leaves `state` at its default, since a
 * gap-filled series is only ever empty when the range/handler produced none.
 */
export function TimeseriesChart({
  series,
  state = 'default',
  errorMessage,
  warnThreshold,
  errorThreshold,
  className,
}: TimeseriesChartProps) {
  if (state === 'loading') {
    return <LoadingState className={className} label="Loading chart…" />;
  }
  if (state === 'error') {
    return <ErrorState className={className} message={errorMessage} />;
  }
  if (state === 'empty' || series.length === 0) {
    return (
      <EmptyState
        className={className}
        title="No data"
        description="No matching events in this range."
      />
    );
  }

  const max = Math.max(1, ...series.map((bucket) => bucket.count));
  const barWidth = 100 / series.length;

  return (
    <svg
      role="img"
      aria-label="Event count over time"
      viewBox={`0 0 100 ${VIEWBOX_HEIGHT}`}
      preserveAspectRatio="none"
      className={cn('h-24 w-full', className)}
    >
      {series.map((bucket, i) => {
        const barHeight = (bucket.count / max) * VIEWBOX_HEIGHT;
        return (
          <rect
            key={bucket.bucketStart}
            data-testid="timeseries-bar"
            x={i * barWidth + BAR_GAP / 2}
            y={VIEWBOX_HEIGHT - barHeight}
            width={Math.max(0, barWidth - BAR_GAP)}
            height={barHeight}
            fill={barFill(bucket.count, warnThreshold, errorThreshold)}
          />
        );
      })}
    </svg>
  );
}
