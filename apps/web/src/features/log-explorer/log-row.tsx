import type { LogLevel } from '@logalot/contracts';
import { LogLevelBadge } from '../../components/ui/log-level-badge';
import { cn } from '../../lib/cn';
import type { TailLogEvent } from './tail-event';

// Presentational rows for the explorer surface. These are PURE (no streaming/
// hook coupling) so #22's historical search renders the exact same row component
// over its result set — the shared "explorer surface" the issue asks for.

// Per-severity left accent, token-driven (no hardcoded color). Mirrors the
// LogLevelBadge palette so a row is scannable by its edge color alone.
const rowAccent: Record<LogLevel, string> = {
  trace: 'border-l-severity-trace-border',
  debug: 'border-l-severity-debug-border',
  info: 'border-l-severity-info-border',
  warn: 'border-l-severity-warn-border',
  error: 'border-l-severity-error-border',
  fatal: 'border-l-severity-fatal-border',
};

/** HH:MM:SS.mmm in the viewer's locale; falls back to the raw string if unparseable. */
export function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
    d.getMilliseconds(),
    3,
  )}`;
}

export interface LogRowProps {
  event: TailLogEvent;
}

/** One dense, level-colored log line. */
export function LogRow({ event }: LogRowProps) {
  const labels = Object.entries(event.labels);
  return (
    <div
      data-level={event.level}
      className={cn(
        'flex items-baseline gap-2 border-border-subtle border-b border-l-2 px-2 py-1 font-mono text-xs hover:bg-bg-hover',
        rowAccent[event.level],
      )}
    >
      <time dateTime={event.ts} className="shrink-0 tabular-nums text-fg-subtle" title={event.ts}>
        {formatTimestamp(event.ts)}
      </time>
      <span className="shrink-0">
        <LogLevelBadge level={event.level} />
      </span>
      <span className="shrink-0 truncate text-fg-muted" title={event.service}>
        {event.service}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-fg-default">
        {event.message}
        {labels.length > 0 ? (
          <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
            {labels.map(([k, v]) => (
              <span key={k} className="rounded-pill bg-bg-elevated px-1.5 text-2xs text-fg-muted">
                <span className="text-fg-subtle">{k}</span>=<span>{v}</span>
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export interface GapRowProps {
  reason: 'dropped' | 'reconnect';
  dropped: number;
}

/**
 * A break in the stream. `dropped` = a slow-consumer shed (query-service `gap`
 * frame, N events lost); `reconnect` = the stream re-opened and, because the tail
 * bus has no replay (ADR-0006), an unknown number of events may have been missed.
 */
export function GapRow({ reason, dropped }: GapRowProps) {
  const label =
    reason === 'dropped'
      ? `${dropped} event${dropped === 1 ? '' : 's'} dropped (slow consumer)`
      : 'stream reconnected — some events may have been missed';
  return (
    <div className="flex items-center gap-2 border-severity-warn-border border-y border-dashed bg-severity-warn-bg px-2 py-1 text-2xs text-fg-muted uppercase tracking-wide">
      <span aria-hidden="true" className="text-severity-warn-fg">
        ⚠
      </span>
      <span>{label}</span>
    </div>
  );
}
