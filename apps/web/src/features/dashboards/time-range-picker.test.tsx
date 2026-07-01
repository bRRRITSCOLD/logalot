import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HOT_WINDOW_MS, isColdRange, type TimeRange, TimeRangePicker } from './time-range-picker';

function range(overrides: Partial<TimeRange> = {}): TimeRange {
  return {
    from: '2026-06-27T11:00:00.000Z',
    to: '2026-06-27T12:00:00.000Z',
    ...overrides,
  };
}

function setup(value: TimeRange = range()) {
  const onChange = vi.fn();
  render(<TimeRangePicker value={value} onChange={onChange} />);
  return { onChange };
}

describe('TimeRangePicker', () => {
  it('renders the active range on the trigger', () => {
    setup();
    expect(screen.getByRole('button', { name: /–/ })).toBeInTheDocument();
  });

  it('selecting a preset emits the expected {from, to}', async () => {
    const u = userEvent.setup();
    const { onChange } = setup();
    const beforeMs = Date.now();

    await u.click(screen.getByRole('button', { name: /–/ }));
    await u.click(await screen.findByRole('button', { name: '1h' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const emitted = onChange.mock.calls[0]?.[0] as TimeRange;
    const afterMs = Date.now();

    // `to` should be "now" (bounded by the call's before/after wall-clock) and
    // `from` exactly one hour earlier — assert the duration precisely and the
    // absolute instant loosely, since real time elapses during the test.
    expect(Date.parse(emitted.to)).toBeGreaterThanOrEqual(beforeMs);
    expect(Date.parse(emitted.to)).toBeLessThanOrEqual(afterMs);
    expect(Date.parse(emitted.to) - Date.parse(emitted.from)).toBe(60 * 60 * 1000);
  });

  it('the absolute picker rejects from >= to', async () => {
    const u = userEvent.setup();
    const { onChange } = setup();

    await u.click(screen.getByRole('button', { name: /–/ }));
    const from = await screen.findByLabelText('From time');
    const to = await screen.findByLabelText('To time');

    await u.clear(from);
    await u.type(from, '2026-06-27T12:00');
    await u.clear(to);
    await u.type(to, '2026-06-27T11:00');
    await u.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByText('"From" must be before "to".')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('the absolute picker emits RFC3339 values when from < to', async () => {
    const u = userEvent.setup();
    const { onChange } = setup();

    await u.click(screen.getByRole('button', { name: /–/ }));
    const from = await screen.findByLabelText('From time');
    const to = await screen.findByLabelText('To time');

    await u.clear(from);
    await u.type(from, '2026-06-27T09:00');
    await u.clear(to);
    await u.type(to, '2026-06-27T10:00');
    await u.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const emitted = onChange.mock.calls[0]?.[0] as TimeRange;
    expect(emitted.from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(emitted.to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(emitted.from)).toBeLessThan(Date.parse(emitted.to));
  });

  it('shows the "cold" badge for a range older than the 30-day hot window', () => {
    const old = new Date(Date.now() - HOT_WINDOW_MS - 60_000).toISOString();
    setup(range({ from: old }));
    expect(screen.getByText('cold')).toBeInTheDocument();
  });

  it('does not show the "cold" badge for a range within the hot window', () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    setup(range({ from: recent, to: new Date().toISOString() }));
    expect(screen.queryByText('cold')).not.toBeInTheDocument();
  });
});

describe('isColdRange', () => {
  const NOW = Date.parse('2026-06-27T12:00:00.000Z');

  it('is true when from is older than 30 days before now', () => {
    expect(isColdRange(new Date(NOW - HOT_WINDOW_MS - 1).toISOString(), NOW)).toBe(true);
  });

  it('is false when from is within the last 30 days', () => {
    expect(isColdRange(new Date(NOW - HOT_WINDOW_MS + 1).toISOString(), NOW)).toBe(false);
  });

  it('is false for an unparseable value', () => {
    expect(isColdRange('not-a-date', NOW)).toBe(false);
  });
});
