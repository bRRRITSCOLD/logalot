import type { LogLevel } from '@logalot/contracts';
import type { TailLogEvent } from './tail-event';

// Pure, client-side filtering over streamed events. The query-service `/v1/tail`
// channel carries the tenant's FULL stream and we filter in the browser (ADR-0006
// allows server-side level/service filters, but the issue scopes filtering to the
// client so a filter change is instant and never forces a stream reconnect). Kept
// as pure functions so the predicate is unit-testable in isolation and reusable by
// #22's historical-search surface, which renders the same rows.

export interface LogFilters {
  /** Case-insensitive substring over the emitting service. Empty = all services. */
  service: string;
  /** Selected severities. Empty = all levels (an explicit "everything" default). */
  levels: LogLevel[];
  /** `key=value` (key exact, value substring) or a free substring over labels. */
  label: string;
  /** Case-insensitive substring over the message text. */
  text: string;
}

export const EMPTY_FILTERS: LogFilters = { service: '', levels: [], label: '', text: '' };

/** Whether any filter is narrowing the stream (drives the "filtered" UI affordance). */
export function filtersActive(f: LogFilters): boolean {
  return (
    f.service.trim() !== '' || f.levels.length > 0 || f.label.trim() !== '' || f.text.trim() !== ''
  );
}

function matchesLabel(labels: Record<string, string>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const eq = q.indexOf('=');
  if (eq >= 0) {
    // `key=value`: key matches exactly (case-insensitive), value is a substring.
    const key = q.slice(0, eq).trim();
    const val = q.slice(eq + 1).trim();
    for (const [k, v] of Object.entries(labels)) {
      if (k.toLowerCase() === key && v.toLowerCase().includes(val)) return true;
    }
    return false;
  }
  // Free text: match any label key or value.
  for (const [k, v] of Object.entries(labels)) {
    if (k.toLowerCase().includes(q) || v.toLowerCase().includes(q)) return true;
  }
  return false;
}

/** Whether `ev` passes every active filter (AND across the four controls). */
export function matchesFilters(ev: TailLogEvent, f: LogFilters): boolean {
  if (f.levels.length > 0 && !f.levels.includes(ev.level)) return false;

  const service = f.service.trim().toLowerCase();
  if (service !== '' && !ev.service.toLowerCase().includes(service)) return false;

  const text = f.text.trim().toLowerCase();
  if (text !== '' && !ev.message.toLowerCase().includes(text)) return false;

  if (!matchesLabel(ev.labels, f.label)) return false;

  return true;
}
