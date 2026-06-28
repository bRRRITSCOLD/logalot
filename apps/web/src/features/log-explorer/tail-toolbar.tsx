import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import type { TailStatus } from './use-log-tail';

// Stream controls + health readout for the live tail. Controlled/presentational:
// the page owns the tail state (via useLogTail) and the autoscroll flag and passes
// them in, so the toolbar is trivially testable and carries no streaming logic.

const STATUS_LABEL: Record<TailStatus, string> = {
  connecting: 'Connecting…',
  streaming: 'Live',
  reconnecting: 'Reconnecting…',
  paused: 'Paused',
};

const STATUS_DOT: Record<TailStatus, string> = {
  connecting: 'bg-status-warning',
  streaming: 'bg-status-success',
  reconnecting: 'bg-status-warning animate-pulse',
  paused: 'bg-fg-subtle',
};

export interface TailToolbarProps {
  status: TailStatus;
  paused: boolean;
  onPause: () => void;
  onResume: () => void;
  autoscroll: boolean;
  onToggleAutoscroll: () => void;
  onClear: () => void;
  /** Rows currently shown (after filtering). */
  visibleCount: number;
  /** Rows buffered (before filtering), for the "x of y" readout. */
  bufferedCount: number;
  droppedCount: number;
  reconnectCount: number;
}

export function TailToolbar({
  status,
  paused,
  onPause,
  onResume,
  autoscroll,
  onToggleAutoscroll,
  onClear,
  visibleCount,
  bufferedCount,
  droppedCount,
  reconnectCount,
}: TailToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-border-default border-b bg-bg-surface px-2 py-1.5">
      {/* Status is a polite live region so AT hears connect/reconnect transitions. */}
      <span
        role="status"
        aria-live="polite"
        className="inline-flex items-center gap-1.5 font-medium text-sm"
      >
        <span
          aria-hidden="true"
          className={cn('inline-block size-2 rounded-full', STATUS_DOT[status])}
        />
        {STATUS_LABEL[status]}
      </span>

      <span className="text-fg-muted text-xs tabular-nums">
        {visibleCount === bufferedCount
          ? `${bufferedCount} rows`
          : `${visibleCount} of ${bufferedCount} rows`}
      </span>

      {droppedCount > 0 ? (
        <span
          className="text-status-warning text-xs tabular-nums"
          title="Events dropped by slow-consumer backpressure"
        >
          {droppedCount} dropped
        </span>
      ) : null}
      {reconnectCount > 0 ? (
        <span className="text-fg-subtle text-xs tabular-nums" title="Times the stream reconnected">
          {reconnectCount} reconnect{reconnectCount === 1 ? '' : 's'}
        </span>
      ) : null}

      <div className="ml-auto flex items-center gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          aria-pressed={autoscroll}
          onClick={onToggleAutoscroll}
        >
          {autoscroll ? 'Autoscroll on' : 'Autoscroll off'}
        </Button>
        {paused ? (
          <Button variant="primary" size="sm" onClick={onResume}>
            Resume
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={onPause}>
            Pause
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}
