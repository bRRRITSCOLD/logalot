import { logLevelSchema } from '@logalot/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LogLevelBadge } from './log-level-badge';

describe('LogLevelBadge', () => {
  it('renders every contract log level with its severity token classes', () => {
    for (const level of logLevelSchema.options) {
      const { container, unmount } = render(<LogLevelBadge level={level} />);
      const badge = container.firstChild as HTMLElement;
      expect(badge).toHaveTextContent(level);
      // One badge, parameterized purely by the severity token triplet.
      expect(badge.className).toContain(`text-severity-${level}-fg`);
      expect(badge.className).toContain(`bg-severity-${level}-bg`);
      expect(badge.className).toContain(`border-severity-${level}-border`);
      unmount();
    }
  });

  it('renders the level label uppercased via CSS (raw text preserved)', () => {
    render(<LogLevelBadge level="error" />);
    // Text node stays lowercase; `uppercase` utility does the visual transform.
    expect(screen.getByText('error')).toBeInTheDocument();
  });

  it('fails loud on an unknown level rather than rendering an unstyled badge', () => {
    // Drift guard: an out-of-contract level must throw at the boundary.
    expect(() =>
      // @ts-expect-error — intentionally invalid level for the negative test.
      render(<LogLevelBadge level="critical" />),
    ).toThrow();
  });
});
