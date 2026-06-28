import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilterBar } from './filter-bar';
import { EMPTY_FILTERS, type LogFilters } from './filtering';

function setup(value: LogFilters = EMPTY_FILTERS) {
  const onChange = vi.fn();
  render(<FilterBar value={value} onChange={onChange} />);
  return { onChange };
}

describe('FilterBar', () => {
  it('emits text changes', async () => {
    const { onChange } = setup();
    await userEvent.type(screen.getByLabelText('Search message text'), 'a');
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTERS, text: 'a' });
  });

  it('emits service changes', async () => {
    const { onChange } = setup();
    await userEvent.type(screen.getByLabelText('Filter by service'), 'x');
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTERS, service: 'x' });
  });

  it('emits label changes', async () => {
    const { onChange } = setup();
    await userEvent.type(screen.getByLabelText('Filter by label'), 'k');
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTERS, label: 'k' });
  });

  it('toggles a level into and out of the selected set via aria-pressed buttons', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<FilterBar value={EMPTY_FILTERS} onChange={onChange} />);
    const errorBtn = screen.getByRole('button', { name: 'error' });
    expect(errorBtn).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(errorBtn);
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTERS, levels: ['error'] });

    // Reflect the new value and toggle back off.
    rerender(<FilterBar value={{ ...EMPTY_FILTERS, levels: ['error'] }} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'error' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'error' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTERS, levels: [] });
  });

  it('shows Clear filters only when a filter is active and resets to empty', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<FilterBar value={EMPTY_FILTERS} onChange={onChange} />);
    expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument();

    rerender(<FilterBar value={{ ...EMPTY_FILTERS, text: 'boom' }} onChange={onChange} />);
    const clear = screen.getByRole('button', { name: /clear filters/i });
    await userEvent.click(clear);
    expect(onChange).toHaveBeenLastCalledWith(EMPTY_FILTERS);
  });
});
