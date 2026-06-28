import { describe, expect, it } from 'vitest';
import {
  buildSearchParams,
  EMPTY_SEARCH_FILTERS,
  filtersFromQuery,
  queryFromFilters,
  type SearchFilters,
  searchFiltersActive,
  searchResponseSchema,
  toRfc3339,
} from './search-query';

function filters(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return { ...EMPTY_SEARCH_FILTERS, ...overrides };
}

describe('toRfc3339', () => {
  it('returns empty for a blank value', () => {
    expect(toRfc3339('')).toBe('');
    expect(toRfc3339('   ')).toBe('');
  });
  it('normalizes an RFC3339 instant to a canonical ISO string', () => {
    expect(toRfc3339('2026-06-27T10:00:00Z')).toBe('2026-06-27T10:00:00.000Z');
  });
  it('converts a tz-less datetime-local value into a valid ISO instant', () => {
    const out = toRfc3339('2026-06-27T10:00');
    // local time is environment-dependent; assert it is a valid RFC3339 instant.
    expect(Number.isNaN(new Date(out).getTime())).toBe(false);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
  it('passes an unparseable value through so the server can reject it (400)', () => {
    expect(toRfc3339('not-a-date')).toBe('not-a-date');
  });
});

describe('buildSearchParams → query-service GET /v1/search querystring', () => {
  it('omits every empty filter (clean default query)', () => {
    expect(buildSearchParams(EMPTY_SEARCH_FILTERS).toString()).toBe('');
  });

  it('maps full-text, service and a single level', () => {
    const p = buildSearchParams(filters({ text: 'timeout', service: 'api', level: 'error' }));
    expect(p.get('q')).toBe('timeout');
    expect(p.get('service')).toBe('api');
    expect(p.get('level')).toBe('error');
  });

  it('trims whitespace and drops filters that are blank after trimming', () => {
    const p = buildSearchParams(filters({ text: '  hi  ', service: '   ' }));
    expect(p.get('q')).toBe('hi');
    expect(p.has('service')).toBe(false);
  });

  it('emits a REPEATED label param per key=value, skipping blank rows', () => {
    const p = buildSearchParams(filters({ labels: ['env=prod', 'region=us-east-1', '  '] }));
    expect(p.getAll('label')).toEqual(['env=prod', 'region=us-east-1']);
  });

  it('preserves a label value that itself contains "=" (split is the server’s job)', () => {
    const p = buildSearchParams(filters({ labels: ['kv=a=b'] }));
    expect(p.getAll('label')).toEqual(['kv=a=b']);
  });

  it('maps the time range to RFC3339 from/to', () => {
    const p = buildSearchParams(
      filters({ from: '2026-06-01T00:00:00Z', to: '2026-06-02T00:00:00Z' }),
    );
    expect(p.get('from')).toBe('2026-06-01T00:00:00.000Z');
    expect(p.get('to')).toBe('2026-06-02T00:00:00.000Z');
  });

  it('passes the keyset cursor verbatim and a limit when supplied', () => {
    const p = buildSearchParams(filters({ text: 'x' }), 'OPAQUE_CURSOR==', 100);
    expect(p.get('cursor')).toBe('OPAQUE_CURSOR==');
    expect(p.get('limit')).toBe('100');
  });

  it('omits cursor/limit when not supplied', () => {
    const p = buildSearchParams(filters({ text: 'x' }));
    expect(p.has('cursor')).toBe(false);
    expect(p.has('limit')).toBe(false);
  });
});

describe('searchFiltersActive', () => {
  it('is false for empty filters', () => {
    expect(searchFiltersActive(EMPTY_SEARCH_FILTERS)).toBe(false);
  });
  it('is true when any control is set', () => {
    expect(searchFiltersActive(filters({ text: 'a' }))).toBe(true);
    expect(searchFiltersActive(filters({ level: 'warn' }))).toBe(true);
    expect(searchFiltersActive(filters({ labels: ['k=v'] }))).toBe(true);
    expect(searchFiltersActive(filters({ from: '2026-06-01T00:00:00Z' }))).toBe(true);
  });
  it('treats a whitespace-only label row as inactive', () => {
    expect(searchFiltersActive(filters({ labels: ['   '] }))).toBe(false);
  });
});

describe('nuqs URL <-> filter mapping', () => {
  it('round-trips filters through the query state', () => {
    const f = filters({
      text: 'oops',
      service: 'billing',
      level: 'fatal',
      labels: ['env=prod'],
      from: '2026-06-01T00:00',
      to: '2026-06-02T00:00',
    });
    expect(filtersFromQuery(queryFromFilters(f))).toEqual(f);
  });
  it('maps an absent level (null in the URL) to the empty selection', () => {
    expect(
      filtersFromQuery({ q: '', service: '', level: null, labels: [], from: '', to: '' }),
    ).toEqual(EMPTY_SEARCH_FILTERS);
  });
  it('maps the empty level selection back to null for a clean URL', () => {
    expect(queryFromFilters(EMPTY_SEARCH_FILTERS).level).toBeNull();
  });
});

describe('searchResponseSchema (reuses the #21 log-event shape)', () => {
  const event = {
    tenant_id: 't-1',
    ts: '2026-06-27T10:00:00Z',
    service: 'api',
    level: 'info',
    message: 'hello',
    labels: { env: 'prod' },
  };

  it('parses a page with events and a nextCursor', () => {
    const parsed = searchResponseSchema.parse({ events: [event], nextCursor: 'NEXT==' });
    expect(parsed.events).toHaveLength(1);
    expect(parsed.nextCursor).toBe('NEXT==');
  });

  it('parses a final page (nextCursor omitted) and an empty page', () => {
    expect(searchResponseSchema.parse({ events: [event] }).nextCursor).toBeUndefined();
    expect(searchResponseSchema.parse({ events: [] }).events).toEqual([]);
  });

  it('normalizes an empty-string nextCursor to undefined (no Load-more page-one loop)', () => {
    expect(
      searchResponseSchema.parse({ events: [event], nextCursor: '' }).nextCursor,
    ).toBeUndefined();
  });

  it('normalizes a null label map to an empty object (kernel emits null)', () => {
    const parsed = searchResponseSchema.parse({ events: [{ ...event, labels: null }] });
    expect(parsed.events[0]?.labels).toEqual({});
  });

  it('rejects an unknown level (fail-closed severity)', () => {
    expect(() => searchResponseSchema.parse({ events: [{ ...event, level: 'bogus' }] })).toThrow();
  });
});
