import { Popover as BasePopover } from '@base-ui-components/react/popover';
import * as React from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { cn } from '../../lib/cn';
import { toRfc3339 } from '../log-search/search-query';

// TimeRangePicker (design-system.md §17): a `secondary` trigger Button showing
// the active range, opening a popover with quick presets (5m/15m/1h/24h/7d/30d)
// plus an absolute from/to picker. Fully controlled — like SearchBar's from/to
// fields, it owns no committed state, only the transient popover-open and
// absolute-draft state — so the URL (nuqs, wired by the detail route in T8) stays
// the single source of truth for the range. Built on Base UI <Popover> for the
// hard accessibility parts (focus, Escape-to-close, positioning), same pattern
// as Dialog wraps Base UI <Dialog>.

export interface TimeRange {
  /** RFC3339 range start. */
  from: string;
  /** RFC3339 range end. */
  to: string;
}

export interface TimeRangePickerProps {
  value: TimeRange;
  onChange: (next: TimeRange) => void;
}

interface Preset {
  label: string;
  ms: number;
}

/** The six quick presets from design-system.md §17, in ascending duration. */
export const TIME_RANGE_PRESETS: readonly Preset[] = [
  { label: '5m', ms: 5 * 60 * 1000 },
  { label: '15m', ms: 15 * 60 * 1000 },
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
];

/** The hot/cold boundary the design calls out: ranges starting before this are "cold". */
export const HOT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** A range is "cold" when its start is older than the 30-day hot window. */
export function isColdRange(from: string, now: number = Date.now()): boolean {
  const fromMs = Date.parse(from);
  if (!Number.isFinite(fromMs)) return false;
  return fromMs < now - HOT_WINDOW_MS;
}

/** Render the active range for the trigger label, e.g. "Jan 1, 00:00 – Jan 2, 00:00". */
function formatRange({ from, to }: TimeRange): string {
  const format = (v: string) => {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toLocaleString() : v;
  };
  if (from === '' && to === '') return 'Select time range';
  return `${format(from)} – ${format(to)}`;
}

export function TimeRangePicker({ value, onChange }: TimeRangePickerProps) {
  const [open, setOpen] = React.useState(false);
  const [fromDraft, setFromDraft] = React.useState('');
  const [toDraft, setToDraft] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setFromDraft(value.from);
      setToDraft(value.to);
      setError(null);
    }
  };

  const applyPreset = (preset: Preset) => {
    const to = Date.now();
    const from = to - preset.ms;
    onChange({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
    setOpen(false);
  };

  const applyAbsolute = () => {
    const from = toRfc3339(fromDraft);
    const to = toRfc3339(toDraft);
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (from === '' || to === '' || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      setError('Enter a valid from and to time.');
      return;
    }
    if (fromMs >= toMs) {
      setError('"From" must be before "to".');
      return;
    }
    setError(null);
    onChange({ from, to });
    setOpen(false);
  };

  const cold = isColdRange(value.from);

  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange}>
      <div className="inline-flex items-center gap-2">
        <BasePopover.Trigger
          render={
            <Button variant="secondary" size="sm">
              {formatRange(value)}
            </Button>
          }
        />
        {cold ? <Badge tone="info">cold</Badge> : null}
      </div>
      <BasePopover.Portal>
        <BasePopover.Positioner sideOffset={8} align="start">
          <BasePopover.Popup
            className={cn(
              'z-popover flex w-72 flex-col gap-3 rounded-card border border-border-default',
              'bg-bg-elevated p-3 shadow-lg',
            )}
          >
            <div className="flex flex-col gap-1">
              <p className="font-medium text-fg-muted text-xs uppercase tracking-wide">
                Quick ranges
              </p>
              <div className="flex flex-wrap gap-1.5">
                {TIME_RANGE_PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => applyPreset(preset)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2 border-border-subtle border-t pt-2">
              <p className="font-medium text-fg-muted text-xs uppercase tracking-wide">
                Absolute range
              </p>
              <span className="flex items-center gap-1 text-fg-subtle text-xs">
                from
                <Input
                  type="datetime-local"
                  value={fromDraft}
                  onChange={(e) => setFromDraft(e.target.value)}
                  aria-label="From time"
                />
              </span>
              <span className="flex items-center gap-1 text-fg-subtle text-xs">
                to
                <Input
                  type="datetime-local"
                  value={toDraft}
                  onChange={(e) => setToDraft(e.target.value)}
                  aria-label="To time"
                />
              </span>
              {error ? <p className="text-severity-error-fg text-xs">{error}</p> : null}
              <Button type="button" size="sm" onClick={applyAbsolute}>
                Apply
              </Button>
            </div>
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
