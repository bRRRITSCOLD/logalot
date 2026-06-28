import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILTERS, type LogFilters } from './filtering';
import { LogExplorer } from './log-explorer';
import type { TailLogEvent } from './tail-event';
import type { EventSourceLike } from './use-log-tail';

// Mocked SSE transport (the AC: "Component/integration tests with mocked SSE pass").
// We deliberately use REAL timers here: the hook coalesces frames on a short
// setInterval, and `findBy*` queries simply await that flush — which composes far
// more cleanly with userEvent than fake timers do.
class MockEventSource implements EventSourceLike {
  static instances: MockEventSource[] = [];
  listeners = new Map<string, ((ev: { data: string }) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: { data: string }) => void) {
    const l = this.listeners.get(type) ?? [];
    l.push(listener);
    this.listeners.set(type, l);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data = '') {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
  static latest() {
    return MockEventSource.instances[MockEventSource.instances.length - 1];
  }
  static reset() {
    MockEventSource.instances = [];
  }
}

function frame(overrides: Partial<TailLogEvent> = {}): string {
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

/** Drive the mock with a short flush interval so findBy* resolves quickly. */
function Harness({ initial = EMPTY_FILTERS }: { initial?: LogFilters }) {
  const [filters, setFilters] = React.useState<LogFilters>(initial);
  return (
    <div style={{ height: 400 }}>
      <LogExplorer
        filters={filters}
        onFiltersChange={setFilters}
        createEventSource={(url) => new MockEventSource(url)}
      />
    </div>
  );
}

beforeEach(() => {
  MockEventSource.reset();
});
afterEach(() => {
  // Unmount happens via RTL cleanup; nothing else to tear down (real timers).
});

function emit(fn: () => void) {
  act(() => {
    fn();
  });
}

describe('LogExplorer (integration, mocked SSE)', () => {
  it('streams rows for the authed tenant into the live view', async () => {
    render(<Harness />);
    const es = MockEventSource.latest();
    expect(es?.url).toBe('/api/tail'); // same-origin BFF, not query-service

    emit(() => {
      es?.emit('open');
      es?.emit('message', frame({ message: 'first line' }));
      es?.emit('message', frame({ message: 'second line', level: 'error' }));
    });

    expect(await screen.findByText('first line')).toBeInTheDocument();
    expect(screen.getByText('second line')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Live');
  });

  it('surfaces a gap marker when the stream sheds events', async () => {
    render(<Harness />);
    const es = MockEventSource.latest();
    emit(() => {
      es?.emit('open');
      es?.emit('gap', '{"dropped":4}');
    });
    expect(await screen.findByText(/4 events dropped/i)).toBeInTheDocument();
  });

  it('pause stops the stream and resume reconnects (gap surfaced)', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    const es1 = MockEventSource.latest();
    emit(() => es1?.emit('open'));

    await u.click(screen.getByRole('button', { name: 'Pause' }));
    expect(es1?.closed).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('Paused');

    await u.click(screen.getByRole('button', { name: 'Resume' }));
    const es2 = MockEventSource.latest();
    expect(es2).not.toBe(es1);
    emit(() => es2?.emit('open'));
    expect(await screen.findByText(/reconnected/i)).toBeInTheDocument();
  });

  it('clear empties the visible view', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    const es = MockEventSource.latest();
    emit(() => {
      es?.emit('open');
      es?.emit('message', frame({ message: 'to be cleared' }));
    });
    expect(await screen.findByText('to be cleared')).toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText('to be cleared')).not.toBeInTheDocument();
  });

  it('applies client-side filters over the streamed rows', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    const es = MockEventSource.latest();
    emit(() => {
      es?.emit('open');
      es?.emit('message', frame({ message: 'keep me', service: 'billing' }));
      es?.emit('message', frame({ message: 'drop me', service: 'api' }));
    });
    expect(await screen.findByText('keep me')).toBeInTheDocument();
    expect(screen.getByText('drop me')).toBeInTheDocument();

    await u.type(screen.getByLabelText('Filter by service'), 'billing');
    expect(screen.getByText('keep me')).toBeInTheDocument();
    expect(screen.queryByText('drop me')).not.toBeInTheDocument();
  });

  it('shows an empty state before any logs arrive', () => {
    render(<Harness />);
    const es = MockEventSource.latest();
    emit(() => es?.emit('open'));
    expect(screen.getByText(/waiting for logs/i)).toBeInTheDocument();
  });

  it('shows a no-match empty state when filters exclude everything', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    const es = MockEventSource.latest();
    emit(() => {
      es?.emit('open');
      es?.emit('message', frame({ message: 'only line' }));
    });
    expect(await screen.findByText('only line')).toBeInTheDocument();

    await u.type(screen.getByLabelText('Search message text'), 'zzz-nomatch');
    expect(screen.getByText(/no matching logs/i)).toBeInTheDocument();
  });

  it('renders the level severity badge inside the streamed row', async () => {
    render(<Harness />);
    const es = MockEventSource.latest();
    emit(() => {
      es?.emit('open');
      es?.emit('message', frame({ message: 'boom', level: 'fatal' }));
    });
    await screen.findByText('boom');
    const logRegion = screen.getByRole('log', { name: /live log stream/i });
    expect(within(logRegion).getByText('fatal')).toBeInTheDocument();
  });
});
