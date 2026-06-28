import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('joins truthy class names', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('drops falsy values', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b');
  });

  it('supports conditional object syntax', () => {
    expect(cn('base', { active: true, hidden: false })).toBe('base active');
  });

  it('lets a later Tailwind utility win over an earlier conflicting one', () => {
    // This is the load-bearing behavior: a caller className overrides a default.
    expect(cn('px-2 text-fg-muted', 'px-4')).toBe('text-fg-muted px-4');
  });
});
