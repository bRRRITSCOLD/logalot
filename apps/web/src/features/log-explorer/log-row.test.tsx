import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatTimestamp, GapRow, LogRow } from './log-row';
import type { TailLogEvent } from './tail-event';

function ev(overrides: Partial<TailLogEvent> = {}): TailLogEvent {
  return {
    tenant_id: 't-1',
    ts: '2026-06-27T10:00:00Z',
    service: 'checkout-api',
    level: 'error',
    message: 'payment failed',
    labels: { region: 'us-east-1' },
    ...overrides,
  };
}

describe('formatTimestamp', () => {
  it('returns the raw string when unparseable', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });
  it('formats a valid ISO timestamp to a clock time', () => {
    expect(formatTimestamp('2026-06-27T10:00:00Z')).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});

describe('LogRow', () => {
  it('renders the message, service, severity badge, and labels', () => {
    render(<LogRow event={ev()} />);
    expect(screen.getByText('payment failed')).toBeInTheDocument();
    expect(screen.getByText('checkout-api')).toBeInTheDocument();
    expect(screen.getByText('error')).toBeInTheDocument(); // LogLevelBadge text
    expect(screen.getByText('region')).toBeInTheDocument();
    expect(screen.getByText('us-east-1')).toBeInTheDocument();
  });

  it('carries the level on data-level and a token-driven severity accent', () => {
    const { container } = render(<LogRow event={ev({ level: 'warn' })} />);
    const row = container.firstChild as HTMLElement;
    expect(row).toHaveAttribute('data-level', 'warn');
    expect(row.className).toContain('border-l-severity-warn-border');
  });

  it('renders cleanly with no labels', () => {
    render(<LogRow event={ev({ labels: {} })} />);
    expect(screen.getByText('payment failed')).toBeInTheDocument();
  });
});

describe('GapRow', () => {
  it('describes a slow-consumer drop with the count', () => {
    render(<GapRow reason="dropped" dropped={5} />);
    expect(screen.getByText(/5 events dropped/i)).toBeInTheDocument();
  });
  it('singularises a single dropped event', () => {
    render(<GapRow reason="dropped" dropped={1} />);
    expect(screen.getByText(/1 event dropped/i)).toBeInTheDocument();
  });
  it('describes a reconnect gap', () => {
    render(<GapRow reason="reconnect" dropped={0} />);
    expect(screen.getByText(/reconnected/i)).toBeInTheDocument();
  });
});
