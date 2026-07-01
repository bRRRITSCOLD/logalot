import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatPanel } from './stat-panel';

describe('StatPanel', () => {
  it('formats a count with a thousands separator', () => {
    render(<StatPanel value={12345} />);
    expect(screen.getByText('12,345')).toBeInTheDocument();
  });

  it('renders zero as "0", not empty', () => {
    render(<StatPanel value={0} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('shows a loading state', () => {
    render(<StatPanel value={12345} state="loading" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('12,345')).not.toBeInTheDocument();
  });

  it('shows an error state with the given message', () => {
    render(<StatPanel value={12345} state="error" errorMessage="panel query not found" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('panel query not found')).toBeInTheDocument();
  });

  it('shows an empty state', () => {
    render(<StatPanel value={0} state="empty" />);
    expect(screen.getByText(/no data/i)).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});
