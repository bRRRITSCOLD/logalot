import type { LogLevel } from '@logalot/contracts';
import * as React from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { logLevelBadgeVariants } from '../../components/ui/log-level-badge';
import { cn } from '../../lib/cn';
import { LOG_LEVELS } from '../log-explorer/tail-event';
import { EMPTY_SEARCH_FILTERS, type SearchFilters, searchFiltersActive } from './search-query';

// Controlled filter builder for historical search. Fully presentational: it owns no
// committed filter state (the route wires `value`/`onChange` to nuqs URL state so a
// search is shareable) — only the transient "new label" draft is local. Unlike the
// tail's FilterBar this maps to the REST contract's exact param semantics: a SINGLE
// `level`, a list of repeated `key=value` `label` filters, and a `from`/`to` range.
// `onSearch` is the explicit commit (Search button / Enter in the text field) that
// the surface turns into a query-service request.

export interface SearchBarProps {
  value: SearchFilters;
  onChange: (next: SearchFilters) => void;
  /** Commit the current filters as a search (Search button or Enter). */
  onSearch: () => void;
  /** Disable controls while a search is in flight. */
  disabled?: boolean;
}

function LevelChip({
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

export function SearchBar({ value, onChange, onSearch, disabled }: SearchBarProps) {
  const [labelDraft, setLabelDraft] = React.useState('');
  const set = (patch: Partial<SearchFilters>) => onChange({ ...value, ...patch });

  // Single-level (radio) semantics: re-selecting the active level clears it.
  const selectLevel = (level: LogLevel) => set({ level: value.level === level ? '' : level });

  const addLabel = () => {
    const draft = labelDraft.trim();
    if (draft === '') return;
    set({ labels: [...value.labels, draft] });
    setLabelDraft('');
  };

  const removeLabel = (index: number) =>
    set({ labels: value.labels.filter((_, i) => i !== index) });

  return (
    <search
      aria-label="Search logs"
      className="flex flex-col gap-2 border-border-default border-b bg-bg-surface p-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          value={value.text}
          disabled={disabled}
          onChange={(e) => set({ text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onSearch();
            }
          }}
          placeholder="Search message text…"
          aria-label="Full-text search"
          className="min-w-[10rem] flex-1"
        />
        <Input
          value={value.service}
          disabled={disabled}
          onChange={(e) => set({ service: e.target.value })}
          placeholder="service"
          aria-label="Filter by service"
          className="w-36"
        />
        <Button onClick={onSearch} disabled={disabled}>
          Search
        </Button>
        {searchFiltersActive(value) ? (
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              onChange({ ...EMPTY_SEARCH_FILTERS });
              setLabelDraft('');
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <fieldset className="flex min-w-0 flex-wrap items-center gap-1 border-0 p-0">
          <legend className="sr-only">Severity level</legend>
          <span className="text-fg-subtle text-xs">level</span>
          {LOG_LEVELS.map((level) => (
            <LevelChip
              key={level}
              level={level}
              active={value.level === level}
              onToggle={() => selectLevel(level)}
              disabled={disabled}
            />
          ))}
        </fieldset>

        {/* aria-label names each control; the visible text is a decorative
            sibling (a wrapping <label> can't see the input inside <Input>). */}
        <span className="flex items-center gap-1 text-fg-subtle text-xs">
          from
          <Input
            type="datetime-local"
            value={value.from}
            disabled={disabled}
            onChange={(e) => set({ from: e.target.value })}
            aria-label="From time"
            className="w-52"
          />
        </span>
        <span className="flex items-center gap-1 text-fg-subtle text-xs">
          to
          <Input
            type="datetime-local"
            value={value.to}
            disabled={disabled}
            onChange={(e) => set({ to: e.target.value })}
            aria-label="To time"
            className="w-52"
          />
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={labelDraft}
          disabled={disabled}
          onChange={(e) => setLabelDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addLabel();
            }
          }}
          placeholder="label  (key=value)"
          aria-label="Add label filter"
          className="w-48"
        />
        <Button variant="secondary" size="sm" disabled={disabled} onClick={addLabel}>
          Add label
        </Button>
        {value.labels.length > 0 ? (
          <ul className="flex flex-wrap items-center gap-1" aria-label="Active label filters">
            {value.labels.map((label, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: labels may repeat; index is the stable identity here.
                key={`${label}-${i}`}
                className="inline-flex items-center gap-1 rounded-pill bg-bg-elevated px-1.5 py-0.5 font-mono text-2xs text-fg-muted"
              >
                <span>{label}</span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => removeLabel(i)}
                  aria-label={`Remove label ${label}`}
                  className="cursor-pointer text-fg-subtle hover:text-fg-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </search>
  );
}
