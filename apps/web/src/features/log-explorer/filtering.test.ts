import { describe, expect, it } from 'vitest';
import { EMPTY_FILTERS, filtersActive, type LogFilters, matchesFilters } from './filtering';
import type { TailLogEvent } from './tail-event';

function ev(overrides: Partial<TailLogEvent> = {}): TailLogEvent {
  return {
    tenant_id: 't-1',
    ts: '2026-06-27T10:00:00Z',
    service: 'api',
    level: 'info',
    message: 'request completed',
    labels: { region: 'us-east-1', status: '200' },
    ...overrides,
  };
}

function filters(overrides: Partial<LogFilters> = {}): LogFilters {
  return { ...EMPTY_FILTERS, ...overrides };
}

describe('filtersActive', () => {
  it('is false for the empty (all) filter set', () => {
    expect(filtersActive(EMPTY_FILTERS)).toBe(false);
  });
  it('is true when any control narrows the stream', () => {
    expect(filtersActive(filters({ service: 'api' }))).toBe(true);
    expect(filtersActive(filters({ levels: ['error'] }))).toBe(true);
    expect(filtersActive(filters({ label: 'region' }))).toBe(true);
    expect(filtersActive(filters({ text: 'boom' }))).toBe(true);
  });
  it('ignores whitespace-only text fields', () => {
    expect(filtersActive(filters({ service: '   ' }))).toBe(false);
  });
});

describe('matchesFilters', () => {
  it('passes everything under the empty filter', () => {
    expect(matchesFilters(ev(), EMPTY_FILTERS)).toBe(true);
  });

  it('filters by level set (empty levels = all)', () => {
    expect(matchesFilters(ev({ level: 'error' }), filters({ levels: ['error', 'fatal'] }))).toBe(
      true,
    );
    expect(matchesFilters(ev({ level: 'info' }), filters({ levels: ['error', 'fatal'] }))).toBe(
      false,
    );
  });

  it('filters by service as a case-insensitive substring', () => {
    expect(matchesFilters(ev({ service: 'checkout-api' }), filters({ service: 'API' }))).toBe(true);
    expect(matchesFilters(ev({ service: 'billing' }), filters({ service: 'api' }))).toBe(false);
  });

  it('filters by message text, case-insensitive', () => {
    expect(matchesFilters(ev({ message: 'Connection BOOM' }), filters({ text: 'boom' }))).toBe(
      true,
    );
    expect(matchesFilters(ev({ message: 'all good' }), filters({ text: 'boom' }))).toBe(false);
  });

  it('matches a label as free substring over keys and values', () => {
    expect(matchesFilters(ev(), filters({ label: 'east' }))).toBe(true); // value substring
    expect(matchesFilters(ev(), filters({ label: 'regi' }))).toBe(true); // key substring
    expect(matchesFilters(ev(), filters({ label: 'west' }))).toBe(false);
  });

  it('matches a label by key=value (key exact, value substring)', () => {
    expect(matchesFilters(ev(), filters({ label: 'region=us-east' }))).toBe(true);
    expect(matchesFilters(ev(), filters({ label: 'region=eu' }))).toBe(false);
    // key must match exactly — a key substring does not satisfy key=value.
    expect(matchesFilters(ev(), filters({ label: 'reg=us' }))).toBe(false);
  });

  it('ANDs all active controls together', () => {
    const f = filters({ levels: ['error'], service: 'api', text: 'fail', label: 'status=500' });
    const match = ev({
      level: 'error',
      service: 'api',
      message: 'request fail',
      labels: { status: '500' },
    });
    expect(matchesFilters(match, f)).toBe(true);
    // one mismatch (wrong level) fails the whole predicate.
    expect(matchesFilters({ ...match, level: 'warn' }, f)).toBe(false);
  });
});
