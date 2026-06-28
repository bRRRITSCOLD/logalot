import type { LogLevel } from '@logalot/contracts';
import { z } from 'zod';
import { type TailLogEvent, tailLogEventSchema } from '../log-explorer/tail-event';

// ── Historical-search domain model + wire mapping (issue #22) ────────────────
//
// query-service GET /v1/search is the REST counterpart of the #21 live tail: it
// runs FTS + structured filters + a time range over the tenant's hot store and
// returns keyset-paginated pages of the SAME `kernel.LogEvent` shape the tail
// streams. This module owns:
//   • SearchFilters — the UI/URL filter model (what the user can express);
//   • buildSearchParams — the SINGLE source of truth mapping that model onto the
//     handler's querystring (q/service/level/from/to/repeated label/cursor/limit),
//     consumed by both the BFF (server/search.ts) and its tests;
//   • searchResponseSchema — the response contract, composed from the #21 event
//     schema so severity/field shape can never drift between tail and search.
//
// SHARED-SCHEMA DECISION: the log-event shape now has TWO consumers (live tail,
// historical search) — rule-of-three is near but not met, and both live inside
// apps/web. So we REUSE `tailLogEventSchema` in place (imported here) rather than
// prematurely lifting it into @logalot/contracts and churning the #21 surface. The
// note in tail-event.ts records the lift as mechanical once a third (cross-package)
// consumer appears.

/**
 * The filters a user can express on the search surface. `level` is a SINGLE
 * selection (the handler accepts one `level` enum, unlike the tail's client-side
 * multi-level filter) and `labels` is a list of `key=value` strings (the handler
 * takes a repeated `label` param). `from`/`to` are datetime-local or RFC3339
 * strings; they are normalized to RFC3339 on the wire.
 */
export interface SearchFilters {
  /** Full-text query (`q`). */
  text: string;
  /** Exact service match (`service`). */
  service: string;
  /** One severity (`level`), or '' for "any". */
  level: LogLevel | '';
  /** Structured label filters, each a `key=value` string (repeated `label`). */
  labels: string[];
  /** Range start; RFC3339 or a datetime-local value (`from`). */
  from: string;
  /** Range end (`to`). */
  to: string;
}

export const EMPTY_SEARCH_FILTERS: SearchFilters = {
  text: '',
  service: '',
  level: '',
  labels: [],
  from: '',
  to: '',
};

/** Whether any filter is narrowing the search (drives the Clear affordance). */
export function searchFiltersActive(f: SearchFilters): boolean {
  return (
    f.text.trim() !== '' ||
    f.service.trim() !== '' ||
    f.level !== '' ||
    f.from.trim() !== '' ||
    f.to.trim() !== '' ||
    f.labels.some((l) => l.trim() !== '')
  );
}

/**
 * Normalize a `from`/`to` value to an RFC3339 instant. A datetime-local value
 * (`YYYY-MM-DDTHH:mm`, no zone) is interpreted in the viewer's local zone and
 * emitted as UTC; an already-RFC3339 value is canonicalized. An unparseable value
 * is passed through unchanged so query-service performs the authoritative
 * validation (and returns a 400 we surface to the user), rather than us silently
 * dropping it.
 */
export function toRfc3339(value: string): string {
  const v = value.trim();
  if (v === '') return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toISOString();
}

/**
 * Map the filter model + pagination position onto the query-service search
 * querystring. Empty filters are omitted (clean default query); labels become
 * REPEATED `label` params (each `key=value`, split server-side on the first `=`,
 * so a value may contain `=`); the cursor is passed VERBATIM. This is the only
 * place the search contract is encoded.
 */
export function buildSearchParams(
  f: SearchFilters,
  cursor?: string,
  limit?: number,
): URLSearchParams {
  const p = new URLSearchParams();

  const q = f.text.trim();
  if (q !== '') p.set('q', q);

  const service = f.service.trim();
  if (service !== '') p.set('service', service);

  if (f.level !== '') p.set('level', f.level);

  const from = toRfc3339(f.from);
  if (from !== '') p.set('from', from);
  const to = toRfc3339(f.to);
  if (to !== '') p.set('to', to);

  for (const raw of f.labels) {
    const label = raw.trim();
    if (label !== '') p.append('label', label);
  }

  if (typeof limit === 'number') p.set('limit', String(limit));
  if (cursor !== undefined && cursor !== '') p.set('cursor', cursor);

  return p;
}

// ── nuqs URL <-> filter mapping ─────────────────────────────────────────────
// The route owns nuqs parsers (level as a string-literal that is null when
// absent, labels as an array). These pure adapters convert between that query
// state and the SearchFilters model, keeping the mapping unit-testable without a
// router/NuqsAdapter in the test.

export interface SearchQueryState {
  q: string;
  service: string;
  level: LogLevel | null;
  labels: string[];
  from: string;
  to: string;
}

export function filtersFromQuery(s: SearchQueryState): SearchFilters {
  return {
    text: s.q,
    service: s.service,
    level: s.level ?? '',
    labels: s.labels,
    from: s.from,
    to: s.to,
  };
}

export function queryFromFilters(f: SearchFilters): SearchQueryState {
  return {
    q: f.text,
    service: f.service,
    level: f.level === '' ? null : f.level,
    labels: f.labels,
    from: f.from,
    to: f.to,
  };
}

// ── Response contract ───────────────────────────────────────────────────────

/**
 * GET /v1/search response: a page of events (always an array; `[]` when empty)
 * plus an optional opaque `nextCursor` (omitted on the final page — its presence
 * drives the "Load more" control). Composed from the #21 event schema.
 */
export const searchResponseSchema = z.object({
  events: z.array(tailLogEventSchema),
  nextCursor: z.string().optional(),
});
export type SearchResult = z.infer<typeof searchResponseSchema>;

/**
 * The result of executing a search, as surfaced to the UI. A failure carries a
 * user-safe message (validation text for a 400, a generic message otherwise); the
 * no-session path is handled upstream by a redirect, never reaching here.
 */
export type SearchOutcome =
  | { ok: true; events: TailLogEvent[]; nextCursor?: string }
  | { ok: false; message: string };

/** Executes one page of a search. Injected so the hook is testable without a BFF. */
export type SearchExecutor = (filters: SearchFilters, cursor?: string) => Promise<SearchOutcome>;
