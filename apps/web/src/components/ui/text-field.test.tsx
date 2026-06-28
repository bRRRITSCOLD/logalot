import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TextField } from './text-field';

describe('TextField', () => {
  it('associates the visible label with the input (Base UI Field wiring)', () => {
    render(<TextField label="Email" />);
    // getByLabelText only resolves if label/control are programmatically linked.
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('marks the control invalid and announces the error message', () => {
    render(<TextField label="Email" error="Email is required" />);
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Email is required')).toBeInTheDocument();
  });

  it('shows the description only when there is no error', () => {
    const { rerender } = render(<TextField label="Email" description="Your work email" />);
    expect(screen.getByText('Your work email')).toBeInTheDocument();

    rerender(<TextField label="Email" description="Your work email" error="Invalid" />);
    expect(screen.queryByText('Your work email')).not.toBeInTheDocument();
    expect(screen.getByText('Invalid')).toBeInTheDocument();
  });

  it('accepts typed input', async () => {
    const user = userEvent.setup();
    render(<TextField label="Email" />);
    const input = screen.getByLabelText('Email');
    await user.type(input, 'a@b.com');
    expect(input).toHaveValue('a@b.com');
  });
});
