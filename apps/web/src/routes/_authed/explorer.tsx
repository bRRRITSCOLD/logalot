import { createFileRoute, useRouter } from '@tanstack/react-router';
import {
  parseAsArrayOf,
  parseAsString,
  parseAsStringLiteral,
  useQueryState,
  useQueryStates,
} from 'nuqs';
import * as React from 'react';
import { Button } from '../../components/ui/button';
import { LOG_LEVELS, LogExplorer, type LogFilters } from '../../features/log-explorer';
import { filtersFromQuery, LogSearch, type SearchFilters } from '../../features/log-search';
import { useSession } from '../../hooks/use-session';
import { cn } from '../../lib/cn';
import { getSession } from '../../server/auth';
import { defaultSearchExecutor } from '../../server/search';

// The explorer surface hosts BOTH the #21 live tail AND #22 historical search as
// two modes of one route — the "toggle / coexistence" the issue calls for. The
// route stays thin: it owns only the URL state (mode + each mode's filters, via
// nuqs so a view is shareable) and renders the relevant feature surface. All
// streaming/auth/fetch logic lives in the BFF + the feature hooks; the tenant is
// always server-derived from the session JWT, never passed here.
export const Route = createFileRoute('/_authed/explorer')({
  component: ExplorerPage,
});

type Mode = 'tail' | 'search';

// Live-tail filters (client-side, multi-level) — unchanged from #21.
const tailFilterParsers = {
  text: parseAsString.withDefault(''),
  service: parseAsString.withDefault(''),
  label: parseAsString.withDefault(''),
  levels: parseAsArrayOf(parseAsStringLiteral(LOG_LEVELS)).withDefault([]),
};

// Historical-search filters. Keys are chosen to NOT collide with the tail's
// (`q` vs `text`, `level` vs `levels`, `labels` vs `label`); `service` is the one
// intentionally shared key, so a service filter carries across a mode switch. Empty
// values are written as `null` so they drop from the URL (clean, shareable links).
const searchFilterParsers = {
  q: parseAsString.withDefault(''),
  service: parseAsString.withDefault(''),
  level: parseAsStringLiteral(LOG_LEVELS), // LogLevel | null (single level on the wire)
  labels: parseAsArrayOf(parseAsString).withDefault([]),
  from: parseAsString.withDefault(''),
  to: parseAsString.withDefault(''),
};

function ExplorerPage() {
  const session = useSession();
  const router = useRouter();

  const [mode, setMode] = useQueryState<Mode>(
    'mode',
    parseAsStringLiteral(['tail', 'search'] as const).withDefault('tail'),
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-semibold text-fg-default text-xl">Log Explorer</h1>
          <ModeToggle mode={mode} onChange={(m) => void setMode(m)} />
        </div>
        <p className="text-fg-muted text-sm">
          {mode === 'tail' ? 'Live tail for tenant ' : 'Search history for tenant '}
          <code className="font-mono text-fg-default">{session.tenantId}</code>
          {mode === 'tail'
            ? ' — new logs stream in as they arrive.'
            : ' — full-text, filters and time range.'}
        </p>
      </header>
      <div className="min-h-0 flex-1">
        {mode === 'tail' ? <TailMode router={router} /> : <SearchMode />}
      </div>
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const tab = (value: Mode, label: string) => (
    <Button
      variant={mode === value ? 'secondary' : 'ghost'}
      size="sm"
      aria-pressed={mode === value}
      onClick={() => onChange(value)}
      className={cn(mode === value && 'shadow-sm')}
    >
      {label}
    </Button>
  );
  return (
    <fieldset className="inline-flex gap-1 rounded-control border border-border-default bg-bg-surface p-0.5">
      <legend className="sr-only">Explorer mode</legend>
      {tab('tail', 'Live tail')}
      {tab('search', 'Search')}
    </fieldset>
  );
}

function TailMode({ router }: { router: ReturnType<typeof useRouter> }) {
  const [query, setQuery] = useQueryStates(tailFilterParsers, {
    history: 'replace',
    throttleMs: 200,
  });

  // When the live tail exhausts its bounded reconnects, decide DEAD SESSION vs
  // outage: `getSession` runs the same decode-or-refresh the guard uses — null ⇒
  // unauthenticated ⇒ redirect to /login (fail closed); a live session means
  // query-service is down, leave the explorer in its offline/Reconnect state.
  const onReconnectExhausted = React.useCallback(async () => {
    const live = await getSession();
    if (!live) await router.navigate({ to: '/login' });
  }, [router]);

  const filters: LogFilters = {
    text: query.text,
    service: query.service,
    label: query.label,
    levels: query.levels,
  };

  const onFiltersChange = React.useCallback(
    (next: LogFilters) => {
      void setQuery({
        text: next.text || null,
        service: next.service || null,
        label: next.label || null,
        levels: next.levels.length > 0 ? next.levels : null,
      });
    },
    [setQuery],
  );

  return (
    <LogExplorer
      filters={filters}
      onFiltersChange={onFiltersChange}
      onReconnectExhausted={onReconnectExhausted}
    />
  );
}

function SearchMode() {
  const [query, setQuery] = useQueryStates(searchFilterParsers, {
    history: 'replace',
    throttleMs: 200,
  });

  const filters: SearchFilters = filtersFromQuery(query);

  const onFiltersChange = React.useCallback(
    (next: SearchFilters) => {
      void setQuery({
        q: next.text || null,
        service: next.service || null,
        level: next.level === '' ? null : next.level,
        labels: next.labels.length > 0 ? next.labels : null,
        from: next.from || null,
        to: next.to || null,
      });
    },
    [setQuery],
  );

  return (
    <LogSearch filters={filters} onFiltersChange={onFiltersChange} search={defaultSearchExecutor} />
  );
}
