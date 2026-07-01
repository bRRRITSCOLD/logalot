import type { Panel, SavedQueryResponse } from '@logalot/contracts';
import { describe, expect, it } from 'vitest';
import { defaultGrid, newPanelId, removePanelById, savedQuerySubtitle, upsertPanel } from './types';

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

describe('upsertPanel', () => {
  it('appends a panel whose id is not already present', () => {
    const existing = [panel({ id: 'p1' })];
    const added = panel({ id: 'p2', title: 'New panel' });
    expect(upsertPanel(existing, added)).toEqual([existing[0], added]);
  });

  it('replaces the panel with a matching id in place', () => {
    const existing = [panel({ id: 'p1', title: 'Original' }), panel({ id: 'p2' })];
    const edited = panel({ id: 'p1', title: 'Edited' });
    expect(upsertPanel(existing, edited)).toEqual([edited, existing[1]]);
  });
});

describe('removePanelById', () => {
  it('filters out the panel matching the given id', () => {
    const existing = [panel({ id: 'p1' }), panel({ id: 'p2' })];
    expect(removePanelById(existing, 'p1')).toEqual([existing[1]]);
  });

  it('is a no-op when the id is not present', () => {
    const existing = [panel({ id: 'p1' })];
    expect(removePanelById(existing, 'missing')).toEqual(existing);
  });
});
