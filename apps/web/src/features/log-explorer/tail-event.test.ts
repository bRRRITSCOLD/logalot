import { describe, expect, it } from 'vitest';
import { parseGapFrame, parseLogFrame, tailLogEventSchema } from './tail-event';

// A frame exactly as the query-service sseSink marshals kernel.LogEvent.
const wireEvent = {
  tenant_id: 't-123',
  ts: '2026-06-27T10:00:00Z',
  id: 'evt-1',
  service: 'api',
  level: 'error',
  message: 'boom',
  labels: { region: 'us-east-1', code: '500' },
  trace_id: 'trace-1',
};

describe('tailLogEventSchema / parseLogFrame', () => {
  it('parses a well-formed data frame mirroring the Go json tags', () => {
    const ev = parseLogFrame(JSON.stringify(wireEvent));
    expect(ev).not.toBeNull();
    expect(ev?.service).toBe('api');
    expect(ev?.level).toBe('error');
    expect(ev?.labels).toEqual({ region: 'us-east-1', code: '500' });
  });

  it('normalises a null label map (Go nil map) to an empty object', () => {
    const ev = parseLogFrame(JSON.stringify({ ...wireEvent, labels: null }));
    expect(ev?.labels).toEqual({});
  });

  it('normalises an absent label map to an empty object', () => {
    const { labels, ...noLabels } = wireEvent;
    void labels;
    const ev = parseLogFrame(JSON.stringify(noLabels));
    expect(ev?.labels).toEqual({});
  });

  it('drops unknown fields (e.g. raw) rather than failing the parse', () => {
    const ev = parseLogFrame(JSON.stringify({ ...wireEvent, raw: { a: 1 }, span_id: 's' }));
    expect(ev).not.toBeNull();
    expect(ev as Record<string, unknown>).not.toHaveProperty('raw');
  });

  it('returns null on malformed JSON (one bad line never throws)', () => {
    expect(parseLogFrame('{not json')).toBeNull();
  });

  it('returns null on an out-of-contract level (shape drift fails closed)', () => {
    expect(parseLogFrame(JSON.stringify({ ...wireEvent, level: 'critical' }))).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    const { service, ...noService } = wireEvent;
    void service;
    expect(parseLogFrame(JSON.stringify(noService))).toBeNull();
  });

  it('accepts every contract log level', () => {
    for (const level of tailLogEventSchema.shape.level.options) {
      const ev = parseLogFrame(JSON.stringify({ ...wireEvent, level }));
      expect(ev?.level).toBe(level);
    }
  });
});

describe('parseGapFrame', () => {
  it('reads the dropped count from a gap frame', () => {
    expect(parseGapFrame('{"dropped":42}')).toBe(42);
  });

  it('returns 0 on malformed input rather than fabricating a gap', () => {
    expect(parseGapFrame('garbage')).toBe(0);
    expect(parseGapFrame('{"dropped":-1}')).toBe(0);
  });
});
