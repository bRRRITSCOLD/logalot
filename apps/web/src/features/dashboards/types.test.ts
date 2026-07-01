import type { Panel, SavedQueryResponse } from '@logalot/contracts';
import { describe, expect, it } from 'vitest';
import { defaultGrid, newPanelId, savedQuerySubtitle } from './types';

function savedQuery(overrides: Partial<SavedQueryResponse> = {}): SavedQueryResponse {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    tenantId: '22222222-2222-2222-2222-222222222222',
    name: '5xx errors',
    description: null,
    queryText: 'level:error',
    filters: {},
    timeRange: {},
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: 'p1',
    type: 'timeseries',
    title: '5xx rate',
    savedQueryId: '11111111-1111-1111-1111-111111111111',
    viz: {},
    grid: { x: 0, y: 0, w: 4, h: 2 },
    ...overrides,
  };
}

describe('savedQuerySubtitle', () => {
  it('resolves a known saved query id to its name', () => {
    const queries = [savedQuery()];
    expect(savedQuerySubtitle(panel(), queries)).toBe('5xx errors');
  });

  it('falls back to a truncated id for an unknown saved query id', () => {
    const unresolved = panel({ savedQueryId: '99999999-9999-9999-9999-999999999999' });
    expect(savedQuerySubtitle(unresolved, [savedQuery()])).toBe('99999999…');
  });
});

describe('newPanelId', () => {
  it('returns a unique id on each call', () => {
    const ids = new Set(Array.from({ length: 20 }, () => newPanelId()));
    expect(ids.size).toBe(20);
  });
});

describe('defaultGrid', () => {
  it('returns a top-left placement with a sensible default size', () => {
    expect(defaultGrid()).toEqual({ x: 0, y: 0, w: 4, h: 2 });
  });
});
