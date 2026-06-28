import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TailLogEvent } from './tail-event';
import { type EventSourceLike, type TailItem, useLogTail } from './use-log-tail';

// A controllable EventSource stand-in. jsdom has no EventSource and we never want a
// live query-service in a unit test, so the hook's injected factory hands tests this
// mock; each instance is registered so a test can drive open/message/gap/error.
class MockEventSource implements EventSourceLike {
  static instances: MockEventSource[] = [];
  listeners = new Map<string, ((ev: { data: string }) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: { data: string }) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data = '') {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
  static latest() {
    return MockEventSource.instances[MockEventSource.instances.length - 1];
  }
  static reset() {
    MockEventSource.instances = [];
  }
}

function factory(url: string): EventSourceLike {
  return new MockEventSource(url);
}

function logFrame(overrides: Partial<TailLogEvent> = {}): string {
  return JSON.stringify({
    tenant_id: 't-1',
    ts: '2026-06-27T10:00:00Z',
    service: 'api',
    level: 'info',
    message: 'hello',
    labels: {},
    ...overrides,
  });
}

const FLUSH = 60;
const opts = { createEventSource: factory, flushIntervalMs: FLUSH, backoffMs: [500, 1000] };

function logItems(items: TailItem[]) {
  return items.filter((i): i is Extract<TailItem, { kind: 'log' }> => i.kind === 'log');
}
function gapItems(items: TailItem[]) {
  return items.filter((i): i is Extract<TailItem, { kind: 'gap' }> => i.kind === 'gap');
}

beforeEach(() => {
  vi.useFakeTimers();
  MockEventSource.reset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useLogTail', () => {
  it('opens the BFF endpoint and streams parsed log rows after a coalesced flush', () => {
    const { result } = renderHook(() => useLogTail({ ...opts, url: '/api/tail' }));
    const es = MockEventSource.latest();
    expect(es?.url).toBe('/api/tail');
    expect(result.current.status).toBe('connecting');

    act(() => {
      es?.emit('open');
    });
    expect(result.current.status).toBe('streaming');

    act(() => {
      es?.emit('message', logFrame({ message: 'one' }));
      es?.emit('message', logFrame({ message: 'two' }));
    });
    // Not yet flushed — bursts coalesce.
    expect(result.current.items).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(FLUSH);
    });
    const logs = logItems(result.current.items);
    expect(logs.map((l) => l.event.message)).toEqual(['one', 'two']);
    expect(result.current.receivedCount).toBe(2);
  });

  it('ignores corrupt frames without stalling the stream', () => {
    const { result } = renderHook(() => useLogTail(opts));
    const es = MockEventSource.latest();
    act(() => {
      es?.emit('open');
      es?.emit('message', '{bad json');
      es?.emit('message', logFrame({ message: 'good' }));
      vi.advanceTimersByTime(FLUSH);
    });
    expect(logItems(result.current.items)).toHaveLength(1);
    expect(result.current.receivedCount).toBe(1);
  });

  it('surfaces a gap marker and accumulates dropped count on a gap frame', () => {
    const { result } = renderHook(() => useLogTail(opts));
    const es = MockEventSource.latest();
    act(() => {
      es?.emit('open');
      es?.emit('gap', '{"dropped":7}');
      vi.advanceTimersByTime(FLUSH);
    });
    const gaps = gapItems(result.current.items);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.reason).toBe('dropped');
    expect(gaps[0]?.dropped).toBe(7);
    expect(result.current.droppedCount).toBe(7);
  });

  it('caps the buffer to maxItems, dropping the oldest rows', () => {
    const { result } = renderHook(() => useLogTail({ ...opts, maxItems: 3 }));
    const es = MockEventSource.latest();
    act(() => {
      es?.emit('open');
      for (let i = 0; i < 5; i++) es?.emit('message', logFrame({ message: `m${i}` }));
      vi.advanceTimersByTime(FLUSH);
    });
    const logs = logItems(result.current.items);
    expect(result.current.items).toHaveLength(3);
    expect(logs.map((l) => l.event.message)).toEqual(['m2', 'm3', 'm4']);
    // Lifetime received still counts every event, even dropped-from-view ones.
    expect(result.current.receivedCount).toBe(5);
  });

  it('reconnects with backoff after an error and marks a reconnect gap on reopen', () => {
    const { result } = renderHook(() => useLogTail(opts));
    const es1 = MockEventSource.latest();
    act(() => {
      es1?.emit('open');
      es1?.emit('message', logFrame({ message: 'before' }));
      vi.advanceTimersByTime(FLUSH);
    });
    expect(logItems(result.current.items)).toHaveLength(1);

    // Transport error → status reconnecting, current source closed, no new source yet.
    act(() => {
      es1?.emit('error');
    });
    expect(result.current.status).toBe('reconnecting');
    expect(es1?.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(1);

    // After the first backoff step a new EventSource is created.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(MockEventSource.instances).toHaveLength(2);
    const es2 = MockEventSource.latest();
    expect(es2).not.toBe(es1);

    // Reopen emits a reconnect gap (pub/sub has no replay → a hole is possible).
    act(() => {
      es2?.emit('open');
      vi.advanceTimersByTime(FLUSH);
    });
    expect(result.current.status).toBe('streaming');
    const gaps = gapItems(result.current.items);
    expect(gaps.some((g) => g.reason === 'reconnect')).toBe(true);
    expect(result.current.reconnectCount).toBe(1);
  });

  it('pause closes the stream; resume reopens and marks a reconnect gap', () => {
    const { result } = renderHook(() => useLogTail(opts));
    const es1 = MockEventSource.latest();
    act(() => {
      es1?.emit('open');
    });
    expect(result.current.status).toBe('streaming');

    act(() => {
      result.current.pause();
    });
    expect(result.current.paused).toBe(true);
    expect(result.current.status).toBe('paused');
    expect(es1?.closed).toBe(true);

    act(() => {
      result.current.resume();
    });
    expect(result.current.paused).toBe(false);
    const es2 = MockEventSource.latest();
    expect(es2).not.toBe(es1);
    act(() => {
      es2?.emit('open');
      vi.advanceTimersByTime(FLUSH);
    });
    expect(gapItems(result.current.items).some((g) => g.reason === 'reconnect')).toBe(true);
  });

  it('clear empties the visible buffer but preserves lifetime counters', () => {
    const { result } = renderHook(() => useLogTail(opts));
    const es = MockEventSource.latest();
    act(() => {
      es?.emit('open');
      es?.emit('message', logFrame());
      es?.emit('gap', '{"dropped":3}');
      vi.advanceTimersByTime(FLUSH);
    });
    expect(result.current.items.length).toBeGreaterThan(0);

    act(() => {
      result.current.clear();
    });
    expect(result.current.items).toHaveLength(0);
    expect(result.current.receivedCount).toBe(1);
    expect(result.current.droppedCount).toBe(3);
  });

  it('closes the EventSource and clears timers on unmount', () => {
    const { unmount, result } = renderHook(() => useLogTail(opts));
    const es = MockEventSource.latest();
    act(() => {
      es?.emit('open');
    });
    void result;
    unmount();
    expect(es?.closed).toBe(true);
    // No further sources are spun up after unmount even if timers advance.
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(MockEventSource.instances).toHaveLength(1);
  });
});
