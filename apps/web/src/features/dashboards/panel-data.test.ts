import { describe, expect, it } from 'vitest';
import {
  buildPanelDataParams,
  gapFillBuckets,
  MAX_PANEL_BUCKETS,
  type PanelBucket,
  panelDataResponseSchema,
} from './panel-data';

const event = {
  tenant_id: 't-1',
  ts: '2026-06-27T10:00:00Z',
  service: 'api',
  level: 'info',
  message: 'hello',
  labels: {},
};

describe('panelDataResponseSchema', () => {
  it('parses a sample payload', () => {
    const parsed = panelDataResponseSchema.parse({
      totalCount: 3,
      buckets: [{ bucketStart: '2026-06-27T10:00:00Z', count: 3 }],
      recentLogs: [event],
    });
    expect(parsed.totalCount).toBe(3);
    expect(parsed.buckets).toHaveLength(1);
    expect(parsed.recentLogs).toHaveLength(1);
    expect(parsed.recentLogs[0]?.labels).toEqual({});
  });

  it('rejects a shape-drifted payload', () => {
    expect(() => panelDataResponseSchema.parse({ totalCount: 'oops' })).toThrow();
  });
});

describe('buildPanelDataParams', () => {
  it('always sends savedQueryId, and encodes from/to as RFC3339', () => {
    const p = buildPanelDataParams({
      savedQueryId: 'sq-1',
      from: '2026-06-27T10:00',
      to: '2026-06-27T11:00',
      buckets: 30,
    });
    expect(p.get('savedQueryId')).toBe('sq-1');
    expect(p.get('from')).toBe(new Date('2026-06-27T10:00').toISOString());
    expect(p.get('to')).toBe(new Date('2026-06-27T11:00').toISOString());
    expect(p.get('buckets')).toBe('30');
  });

  it('omits from/to/buckets when not provided (handler applies its own defaults)', () => {
    const p = buildPanelDataParams({ savedQueryId: 'sq-1' });
    expect(p.get('savedQueryId')).toBe('sq-1');
    expect(p.has('from')).toBe(false);
    expect(p.has('to')).toBe(false);
    expect(p.has('buckets')).toBe(false);
  });

  it(`clamps buckets to ${MAX_PANEL_BUCKETS}`, () => {
    const p = buildPanelDataParams({ savedQueryId: 'sq-1', buckets: 500 });
    expect(p.get('buckets')).toBe(String(MAX_PANEL_BUCKETS));
  });

  it('clamps a non-positive bucket count up to 1 rather than sending it verbatim', () => {
    const p = buildPanelDataParams({ savedQueryId: 'sq-1', buckets: -5 });
    expect(p.get('buckets')).toBe('1');
  });
});

describe('gapFillBuckets', () => {
  const from = '2026-06-27T10:00:00.000Z';
  const to = '2026-06-27T10:04:00.000Z'; // 4 buckets of 1 minute each

  it('fills zeros between sparse buckets and stays time-monotonic', () => {
    const sparse: PanelBucket[] = [{ bucketStart: '2026-06-27T10:02:00.000Z', count: 5 }];
    const dense = gapFillBuckets(sparse, from, to, 4);

    expect(dense).toHaveLength(4);
    expect(dense.map((b) => b.count)).toEqual([0, 0, 5, 0]);
    expect(dense[0]?.bucketStart).toBe('2026-06-27T10:00:00.000Z');
    expect(dense[2]?.bucketStart).toBe('2026-06-27T10:02:00.000Z');

    // time-monotonic: each bucketStart strictly increases
    const times = dense.map((b) => Date.parse(b.bucketStart));
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1] as number);
    }
  });

  it('handles the empty-buckets case by producing an all-zero dense series', () => {
    const dense = gapFillBuckets([], from, to, 4);
    expect(dense).toHaveLength(4);
    expect(dense.every((b) => b.count === 0)).toBe(true);
  });

  it('returns an empty series for a non-positive bucket count', () => {
    expect(gapFillBuckets([], from, to, 0)).toEqual([]);
  });

  it('returns an empty series when the range is invalid (to <= from)', () => {
    expect(gapFillBuckets([], to, from, 4)).toEqual([]);
  });
});
