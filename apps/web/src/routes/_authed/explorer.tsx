import { createFileRoute } from '@tanstack/react-router';
import { parseAsArrayOf, parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';
import * as React from 'react';
import { LOG_LEVELS, LogExplorer, type LogFilters } from '../../features/log-explorer';
import { useSession } from '../../hooks/use-session';

// Live log explorer + tail. The route stays thin: it owns only the filter URL-state
// (via nuqs, the deferred-from-#20 dependency) and renders the LogExplorer surface.
// The actual streaming/auth lives in the BFF `/api/tail` route + `useLogTail`; the
// tenant is server-derived from the session JWT the BFF forwards, never passed here.
export const Route = createFileRoute('/_authed/explorer')({
  component: ExplorerPage,
});

// Filters live in the URL so a view is shareable/bookmarkable and survives reloads.
// `history: 'replace'` keeps the back button usable while typing; empty values are
// written as `null` so they drop out of the query string (clean URLs).
const filterParsers = {
  text: parseAsString.withDefault(''),
  service: parseAsString.withDefault(''),
  label: parseAsString.withDefault(''),
  levels: parseAsArrayOf(parseAsStringLiteral(LOG_LEVELS)).withDefault([]),
};

function ExplorerPage() {
  const session = useSession();
  const [query, setQuery] = useQueryStates(filterParsers, {
    history: 'replace',
    throttleMs: 200,
  });

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
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="flex flex-col gap-0.5">
        <h1 className="font-semibold text-fg-default text-xl">Log Explorer</h1>
        <p className="text-fg-muted text-sm">
          Live tail for tenant <code className="font-mono text-fg-default">{session.tenantId}</code>{' '}
          — new logs stream in as they arrive.
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <LogExplorer filters={filters} onFiltersChange={onFiltersChange} />
      </div>
    </div>
  );
}
