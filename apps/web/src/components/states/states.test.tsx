import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './empty-state';
import { LoadingState } from './loading-state';

describe('LoadingState', () => {
  it('exposes an accessible busy status', () => {
    render(<LoadingState label="Loading logs…" />);
    // The Spinner carries role="status"; its aria-label announces the activity.
    expect(screen.getByRole('status', { name: 'Loading logs…' })).toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('renders title, description, and an optional action', () => {
    render(
      <EmptyState
        title="No results"
        description="Try a broader query"
        action={<button type="button">Reset</button>}
      />,
    );
    expect(screen.getByText('No results')).toBeInTheDocument();
    expect(screen.getByText('Try a broader query')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
  });
});
