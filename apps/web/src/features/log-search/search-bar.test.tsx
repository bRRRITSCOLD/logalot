import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SearchBar } from './search-bar';
import { EMPTY_SEARCH_FILTERS, type SearchFilters } from './search-query';

/** Controlled wrapper so onChange actually updates the rendered value. */
function Harness({
  initial = EMPTY_SEARCH_FILTERS,
  onSearch = () => {},
}: {
  initial?: SearchFilters;
  onSearch?: () => void;
}) {
  const [value, setValue] = React.useState<SearchFilters>(initial);
  return <SearchBar value={value} onChange={setValue} onSearch={onSearch} />;
}

describe('SearchBar', () => {
  it('edits the full-text and service filters', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    await u.type(screen.getByLabelText(/full-text search/i), 'timeout');
    await u.type(screen.getByLabelText(/filter by service/i), 'api');
    expect(screen.getByLabelText(/full-text search/i)).toHaveValue('timeout');
    expect(screen.getByLabelText(/filter by service/i)).toHaveValue('api');
  });

  it('selects a SINGLE severity level (radio semantics) and clears it on re-click', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    const error = screen.getByRole('button', { name: 'error' });
    const warn = screen.getByRole('button', { name: 'warn' });

    await u.click(error);
    expect(error).toHaveAttribute('aria-pressed', 'true');

    // selecting another replaces, not adds (single level on the wire)
    await u.click(warn);
    expect(warn).toHaveAttribute('aria-pressed', 'true');
    expect(error).toHaveAttribute('aria-pressed', 'false');

    // re-click clears the selection
    await u.click(warn);
    expect(warn).toHaveAttribute('aria-pressed', 'false');
  });

  it('adds and removes structured label filters', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    const labelInput = screen.getByLabelText(/add label/i);
    await u.type(labelInput, 'env=prod');
    await u.click(screen.getByRole('button', { name: /^add label$/i }));

    expect(screen.getByText('env=prod')).toBeInTheDocument();
    expect(labelInput).toHaveValue(''); // draft cleared after add

    await u.click(screen.getByRole('button', { name: /remove label env=prod/i }));
    expect(screen.queryByText('env=prod')).not.toBeInTheDocument();
  });

  it('adds a label on Enter without triggering a search', async () => {
    const u = userEvent.setup();
    const onSearch = vi.fn();
    render(<Harness onSearch={onSearch} />);
    await u.type(screen.getByLabelText(/add label/i), 'region=us-east-1{Enter}');
    expect(screen.getByText('region=us-east-1')).toBeInTheDocument();
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('exposes from/to time-range inputs', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    const from = screen.getByLabelText(/from time/i);
    const to = screen.getByLabelText(/to time/i);
    await u.type(from, '2026-06-01T00:00');
    await u.type(to, '2026-06-02T00:00');
    expect(from).toHaveValue('2026-06-01T00:00');
    expect(to).toHaveValue('2026-06-02T00:00');
  });

  it('fires onSearch when the Search button is clicked', async () => {
    const u = userEvent.setup();
    const onSearch = vi.fn();
    render(<Harness onSearch={onSearch} />);
    await u.click(screen.getByRole('button', { name: /^search$/i }));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('fires onSearch when Enter is pressed in the full-text field', async () => {
    const u = userEvent.setup();
    const onSearch = vi.fn();
    render(<Harness onSearch={onSearch} />);
    await u.type(screen.getByLabelText(/full-text search/i), 'oops{Enter}');
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('shows a Clear control only when filters are active, resetting them', async () => {
    const u = userEvent.setup();
    render(<Harness initial={{ ...EMPTY_SEARCH_FILTERS, text: 'x', level: 'error' }} />);
    const clear = screen.getByRole('button', { name: /clear filters/i });
    await u.click(clear);
    expect(screen.getByLabelText(/full-text search/i)).toHaveValue('');
    expect(screen.getByRole('button', { name: 'error' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument();
  });
});
