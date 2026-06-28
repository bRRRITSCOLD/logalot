import type { LogLevel } from '@logalot/contracts';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { logLevelBadgeVariants } from '../../components/ui/log-level-badge';
import { cn } from '../../lib/cn';
import { EMPTY_FILTERS, filtersActive, type LogFilters } from './filtering';
import { LOG_LEVELS } from './tail-event';

// Controlled filter controls for the explorer surface. Fully presentational: it
// owns no state, taking `value` + `onChange` so the OWNER decides where filter
// state lives — the live-tail page wires it to nuqs URL state; #22's search page
// can reuse the same component against its own state.

export interface FilterBarProps {
  value: LogFilters;
  onChange: (next: LogFilters) => void;
  /** Disable inputs (e.g. while reconnecting). Optional. */
  disabled?: boolean;
}

function LevelToggle({
  level,
  active,
  onToggle,
  disabled,
}: {
  level: LogLevel;
  active: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        logLevelBadgeVariants({ level }),
        'cursor-pointer py-0.5 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
        active ? 'opacity-100' : 'opacity-35 hover:opacity-70',
        disabled && 'cursor-not-allowed',
      )}
    >
      {level}
    </button>
  );
}

export function FilterBar({ value, onChange, disabled }: FilterBarProps) {
  const set = (patch: Partial<LogFilters>) => onChange({ ...value, ...patch });

  const toggleLevel = (level: LogLevel) => {
    const next = value.levels.includes(level)
      ? value.levels.filter((l) => l !== level)
      : [...value.levels, level];
    set({ levels: next });
  };

  return (
    <search
      aria-label="Filter logs"
      className="flex flex-wrap items-center gap-2 border-border-default border-b bg-bg-surface p-2"
    >
      <Input
        type="search"
        value={value.text}
        disabled={disabled}
        onChange={(e) => set({ text: e.target.value })}
        placeholder="Search message…"
        aria-label="Search message text"
        className="min-w-[8rem] flex-1"
      />

      <Input
        value={value.service}
        disabled={disabled}
        onChange={(e) => set({ service: e.target.value })}
        placeholder="service"
        aria-label="Filter by service"
        className="w-36"
      />

      <Input
        value={value.label}
        disabled={disabled}
        onChange={(e) => set({ label: e.target.value })}
        placeholder="label  (key=value)"
        aria-label="Filter by label"
        className="w-44"
      />

      <fieldset className="flex min-w-0 flex-wrap items-center gap-1 border-0 p-0">
        <legend className="sr-only">Filter by level</legend>
        {LOG_LEVELS.map((level) => (
          <LevelToggle
            key={level}
            level={level}
            active={value.levels.includes(level)}
            onToggle={() => toggleLevel(level)}
            disabled={disabled}
          />
        ))}
      </fieldset>

      {filtersActive(value) ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onChange({ ...EMPTY_FILTERS })}
        >
          Clear filters
        </Button>
      ) : null}
    </search>
  );
}
