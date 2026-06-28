import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button, buttonVariants } from './button';

describe('Button', () => {
  it('renders its children as an accessible button', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('defaults to type="button" to avoid accidental form submits', () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('applies the requested variant + size token classes', () => {
    render(
      <Button variant="danger" size="lg">
        Delete
      </Button>,
    );
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('bg-status-danger');
    expect(btn.className).toContain('h-10');
  });

  it('lets a caller className override a default (cn merge)', () => {
    render(<Button className="h-20">Tall</Button>);
    // h-20 wins over the default size h-8.
    expect(screen.getByRole('button').className).toContain('h-20');
    expect(screen.getByRole('button').className).not.toContain('h-8');
  });

  it('fires onClick and respects disabled', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Button onClick={onClick}>Click</Button>);
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button onClick={onClick} disabled>
        Click
      </Button>,
    );
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1); // still 1 — disabled blocked it
  });

  it('exposes buttonVariants for composing onto non-button elements', () => {
    expect(buttonVariants({ variant: 'primary' })).toContain('bg-brand-solid');
  });
});
