import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Alert } from './alert';

describe('Alert', () => {
  it('announces danger/warning assertively via role="alert"', () => {
    render(
      <Alert tone="danger" title="Sign-in failed">
        Invalid credentials
      </Alert>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Sign-in failed');
    expect(alert).toHaveTextContent('Invalid credentials');
  });

  it('uses the polite role="status" for informational tone', () => {
    render(<Alert tone="info">Heads up</Alert>);
    expect(screen.getByRole('status')).toHaveTextContent('Heads up');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
