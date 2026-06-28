import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TailToolbar, type TailToolbarProps } from './tail-toolbar';

function setup(overrides: Partial<TailToolbarProps> = {}) {
  const props: TailToolbarProps = {
    status: 'streaming',
    paused: false,
    onPause: vi.fn(),
    onResume: vi.fn(),
    onReconnect: vi.fn(),
    autoscroll: true,
    onToggleAutoscroll: vi.fn(),
    onClear: vi.fn(),
    visibleCount: 10,
    bufferedCount: 10,
    droppedCount: 0,
    reconnectCount: 0,
    ...overrides,
  };
  render(<TailToolbar {...props} />);
  return props;
}

describe('TailToolbar', () => {
  it('announces the live status in a polite live region', () => {
    setup({ status: 'streaming' });
    const live = screen.getByRole('status');
    expect(live).toHaveTextContent('Live');
    expect(live).toHaveAttribute('aria-live', 'polite');
  });

  it('reflects reconnecting status', () => {
    setup({ status: 'reconnecting' });
    expect(screen.getByRole('status')).toHaveTextContent(/reconnecting/i);
  });

  it('shows a Pause button when streaming and fires onPause', async () => {
    const props = setup({ paused: false });
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(props.onPause).toHaveBeenCalledOnce();
  });

  it('shows a Resume button when paused and fires onResume', async () => {
    const props = setup({ paused: true, status: 'paused' });
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(props.onResume).toHaveBeenCalledOnce();
  });

  it('shows a Reconnect button (not Pause) when offline and fires onReconnect', async () => {
    const props = setup({ status: 'offline' });
    expect(screen.getByRole('status')).toHaveTextContent(/disconnected/i);
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(props.onReconnect).toHaveBeenCalledOnce();
  });

  it('toggles autoscroll and reflects its pressed state', async () => {
    const props = setup({ autoscroll: true });
    const btn = screen.getByRole('button', { name: /autoscroll on/i });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(btn);
    expect(props.onToggleAutoscroll).toHaveBeenCalledOnce();
  });

  it('fires onClear', async () => {
    const props = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(props.onClear).toHaveBeenCalledOnce();
  });

  it('shows dropped and reconnect counters only when non-zero', () => {
    const { rerender } = render(
      <TailToolbar
        status="streaming"
        paused={false}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onReconnect={vi.fn()}
        autoscroll
        onToggleAutoscroll={vi.fn()}
        onClear={vi.fn()}
        visibleCount={5}
        bufferedCount={20}
        droppedCount={0}
        reconnectCount={0}
      />,
    );
    expect(screen.queryByText(/dropped/i)).not.toBeInTheDocument();
    // "x of y" readout when filtered.
    expect(screen.getByText('5 of 20 rows')).toBeInTheDocument();

    rerender(
      <TailToolbar
        status="streaming"
        paused={false}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onReconnect={vi.fn()}
        autoscroll
        onToggleAutoscroll={vi.fn()}
        onClear={vi.fn()}
        visibleCount={20}
        bufferedCount={20}
        droppedCount={3}
        reconnectCount={2}
      />,
    );
    expect(screen.getByText('3 dropped')).toBeInTheDocument();
    expect(screen.getByText('2 reconnects')).toBeInTheDocument();
    expect(screen.getByText('20 rows')).toBeInTheDocument();
  });
});
